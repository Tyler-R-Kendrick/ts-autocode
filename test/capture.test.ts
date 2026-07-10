import { describe, expect, it } from "vitest";

import {
	createCaptureRuntime,
	reconstructTrajectoryFromLog,
	recoverCandidateTrajectorySet,
	replayTrainingRun,
	trainable,
	validateTrajectory,
} from "../src/index.js";
import { FIXTURE_TRACEPARENT, classifierRegion, classifierRegionDigest } from "./fixtures.js";

const run = {
	id: "run-capture-1",
	tenantId: "tenant-a",
	traceparent: FIXTURE_TRACEPARENT,
};

const method = {
	name: "classify",
	contractRef: "contract://classify@1.0.0",
	generatedRegion: classifierRegion(),
	regionDigest: classifierRegionDigest(),
};

describe("createCaptureRuntime", () => {
	it("captures a valid trajectory with root and child spans", () => {
		const runtime = createCaptureRuntime();
		const capture = runtime.captureInvocation({
			run,
			method,
			inputs: { input: "billing invoice" },
			outputs: { label: "general-support" },
			payloads: { input: "billing invoice", baselineLabel: "general-support" },
			childSpans: [
				{
					name: "llm.classify",
					kind: "LLM",
					genAi: {
						provider: "local",
						requestModel: "stub-classifier",
						usage: { inputTokens: 12, outputTokens: 3 },
					},
				},
			],
			scores: [{ name: "reward", value: 0.8, source: "live-eval", rubricRef: "rubric://classify@1.0.0" }],
		});

		expect(capture.captured).toBe(true);
		const trajectory = capture.trajectory;
		if (trajectory === null) throw new Error("expected trajectory");
		expect(validateTrajectory(trajectory).ok).toBe(true);
		expect(trajectory.spans).toHaveLength(2);
		expect(trajectory.spans[1]?.parentId).toBe(trajectory.spans[0]?.id);
		expect(trajectory.payloads["input"]?.value).toBe("billing invoice");
	});

	it("redacts sensitive payloads with run-scoped refs and no raw value", () => {
		const runtime = createCaptureRuntime({ runKeyRef: "run-key://tenant-a" });
		const capture = runtime.captureInvocation({
			run,
			method,
			payloads: { input: "billing invoice", email: "user@example.com" },
			sensitiveFields: ["email"],
			scores: [{ name: "reward", value: 0.8, source: "live-eval", rubricRef: "rubric://classify@1.0.0" }],
		});

		const email = capture.trajectory?.payloads["email"];
		expect(email?.redaction).toBe("encrypted");
		expect(email?.encryptedRef).toBe(`run://${run.id}/payloads/email`);
		expect(email?.value).toBeUndefined();
		expect(validateTrajectory(capture.trajectory).ok).toBe(true);
	});

	it("contentCapture \"ref\" replaces message content with run-scoped refs", () => {
		const runtime = createCaptureRuntime({ runKeyRef: "run-key://tenant-a", contentCapture: "ref" });
		const capture = runtime.captureInvocation({
			run,
			method,
			payloads: { input: "billing invoice" },
			scores: [{ name: "reward", value: 0.8, source: "live-eval" }],
			childSpans: [
				{
					name: "llm.classify",
					kind: "LLM",
					genAi: {
						requestModel: "stub-classifier",
						usage: { inputTokens: 12, outputTokens: 3 },
						inputMessages: [{ role: "user", content: "the secret prompt" }],
						outputMessages: [{ role: "assistant", content: "the secret answer" }],
						systemInstructions: "the secret instructions",
					},
				},
			],
		});

		const serialized = JSON.stringify(capture.trajectory);
		expect(serialized).not.toContain("the secret prompt");
		expect(serialized).not.toContain("the secret answer");
		expect(serialized).not.toContain("the secret instructions");
		const llmSpan = capture.trajectory?.spans[1];
		expect(llmSpan?.genAi?.inputMessages?.[0]?.content).toEqual({
			ref: `run://${run.id}/spans/${llmSpan?.id}/input/0`,
		});
		expect(llmSpan?.genAi?.systemInstructions).toEqual({
			ref: `run://${run.id}/spans/${llmSpan?.id}/system_instructions`,
		});
	});

	it("contentCapture \"none\" drops message content entirely", () => {
		const runtime = createCaptureRuntime({ contentCapture: "none" });
		const capture = runtime.captureInvocation({
			run,
			method,
			scores: [{ name: "reward", value: 0.8, source: "live-eval" }],
			childSpans: [
				{
					name: "llm.classify",
					kind: "LLM",
					genAi: {
						requestModel: "stub-classifier",
						usage: { inputTokens: 12, outputTokens: 3 },
						inputMessages: [{ role: "user", content: "the secret prompt" }],
					},
				},
			],
		});

		expect(JSON.stringify(capture.trajectory)).not.toContain("the secret prompt");
		expect(capture.trajectory?.spans[1]?.genAi?.inputMessages?.[0]).toEqual({ role: "user" });
	});

	it("refuses sensitive payloads without a runKeyRef", () => {
		const runtime = createCaptureRuntime();
		expect(() =>
			runtime.captureInvocation({
				run,
				method,
				payloads: { email: "user@example.com" },
				sensitiveFields: ["email"],
				scores: [{ name: "reward", value: 0.8, source: "live-eval", rubricRef: "rubric://classify@1.0.0" }],
			}),
		).toThrowError(/requires a runKeyRef/);
	});

	it("records sampled-out invocations without capturing payloads", () => {
		const runtime = createCaptureRuntime({ sampling: { capture: false, reason: "tenant-opt-out" } });
		const capture = runtime.captureInvocation({
			run,
			method,
			payloads: { input: "billing invoice" },
		});

		expect(capture.captured).toBe(false);
		expect(capture.trajectory).toBeNull();
		const log = runtime.eventLog();
		expect(log.map((event) => event.type)).toEqual(["training.TrajectorySampledOut"]);
		expect(replayTrainingRun(log).sampledOutIds).toEqual([capture.trajectoryId]);
	});

	it("emits a replayable, valid event log", () => {
		const runtime = createCaptureRuntime();
		runtime.captureInvocation({
			run,
			method,
			payloads: { input: "billing invoice" },
			scores: [{ name: "reward", value: 0.8, source: "live-eval", rubricRef: "rubric://classify@1.0.0" }],
		});
		const projection = replayTrainingRun(runtime.eventLog());

		expect(projection.trajectoryIds).toEqual(["trajectory-run-capture-1-1"]);
		expect(projection.spanCount).toBe(1);
	});
});

describe("trainable", () => {
	it("wraps a function so calls record trajectories against its region", () => {
		const runtime = createCaptureRuntime();
		const classify = trainable((input: string) => (input.includes("billing") ? "billing-support" : "general-support"), {
			runtime,
			run,
			method,
		});

		expect(classify("billing invoice")).toBe("billing-support");
		expect(classify("hello")).toBe("general-support");
		expect(classify.trajectoryIds).toHaveLength(2);
		expect(classify.region.regionId).toBe("classify-body");

		const trajectory = reconstructTrajectoryFromLog(runtime.eventLog(), classify.trajectoryIds[0] as string);
		expect(trajectory.payloads["input"]?.value).toBe("billing invoice");
		expect(trajectory.payloads["baselineLabel"]?.value).toBe("billing-support");
		expect(trajectory.feedback?.[0]).toEqual({ kind: "text", text: "reward pending: contract://classify@1.0.0" });
	});

	it("captures a throw as error feedback and rethrows", () => {
		const runtime = createCaptureRuntime();
		const explode = trainable(
			(_input: string): string => {
				throw new Error("classifier crashed");
			},
			{ runtime, run, method },
		);

		expect(() => explode("billing invoice")).toThrowError("classifier crashed");
		const trajectory = reconstructTrajectoryFromLog(runtime.eventLog(), explode.trajectoryIds[0] as string);
		expect(trajectory.feedback).toEqual([{ kind: "error", message: "classifier crashed" }]);
	});
});

describe("audit reconstruction", () => {
	it("verifies hashes and span evidence when reconstructing", () => {
		const runtime = createCaptureRuntime();
		const capture = runtime.captureInvocation({
			run,
			method,
			payloads: { input: "billing invoice" },
			scores: [{ name: "reward", value: 0.8, source: "live-eval", rubricRef: "rubric://classify@1.0.0" }],
		});

		const trajectory = reconstructTrajectoryFromLog(runtime.eventLog(), capture.trajectoryId);
		expect(trajectory.id).toBe(capture.trajectoryId);
		expect(() => reconstructTrajectoryFromLog(runtime.eventLog(), "missing")).toThrowError(/not found/);
	});

	it("recovers the hash-verified evidence set behind a candidate", () => {
		const runtime = createCaptureRuntime();
		const capture = runtime.captureInvocation({
			run,
			method,
			payloads: { input: "billing invoice" },
			scores: [{ name: "reward", value: 0.8, source: "live-eval", rubricRef: "rubric://classify@1.0.0" }],
		});
		const region = classifierRegion();
		runtime.recordCandidateProposed({
			runId: run.id,
			candidate: {
				schema: "ts-autocode.training.candidate-patch/v1",
				id: "candidate-x",
				engineId: "engine-x",
				regions: [region],
				edits: [
					{
						regionId: region.regionId,
						startOffset: region.startOffset,
						endOffset: region.endOffset,
						replacement: '  return "billing-support";',
					},
				],
				provenance: { trajectoryHashes: [], rubricRef: "r", contractRef: "c" },
			},
			trajectoryIds: [capture.trajectoryId],
		});

		const evidence = recoverCandidateTrajectorySet(runtime.eventLog(), "candidate-x");
		expect(evidence).toHaveLength(1);
		expect(evidence[0]?.trajectory.id).toBe(capture.trajectoryId);
		expect(evidence[0]?.hash).toMatch(/^sha256:/);
	});
});
