import { describe, expect, it } from "vitest";

import {
	createCaptureRuntime,
	fromOtelSpans,
	toOtlpJson,
	validateTrajectory,
} from "../src/index.js";
import {
	FIXTURE_TRACEPARENT,
	classifierRegion,
	classifierRegionDigest,
	makeTrajectory,
} from "./fixtures.js";

const trajectory = makeTrajectory({
	id: "t-otlp",
	input: "billing invoice refund",
	baselineLabel: "general-support",
	expectedLabel: "billing-support",
});

describe("toOtlpJson", () => {
	it("emits standard OTLP/JSON with KeyValue attributes and nano timestamps", () => {
		const otlp = toOtlpJson([trajectory], { resource: { "service.name": "classifier" } });

		const scopeSpans = otlp.resourceSpans[0]?.scopeSpans[0];
		expect(otlp.resourceSpans[0]?.resource.attributes).toContainEqual({
			key: "service.name",
			value: { stringValue: "classifier" },
		});
		expect(scopeSpans?.scope.name).toBe("ts-autocode");
		expect(scopeSpans?.spans).toHaveLength(2);

		const root = scopeSpans?.spans.find((span) => span.parentSpanId === undefined);
		const llm = scopeSpans?.spans.find((span) => span.parentSpanId !== undefined);
		expect(root?.traceId).toBe(FIXTURE_TRACEPARENT.slice(3, 35));
		expect(root?.startTimeUnixNano).toBe(String(BigInt(Date.parse("2026-06-25T09:00:00.000Z")) * 1_000_000n));
		expect(root?.status).toEqual({ code: 1 });
		// LLM spans map to CLIENT kind; the dual-convention attrs ride along.
		expect(llm?.kind).toBe(3);
		expect(llm?.attributes).toContainEqual({ key: "gen_ai.request.model", value: { stringValue: "stub-classifier" } });
		expect(llm?.attributes).toContainEqual({ key: "llm.token_count.prompt", value: { intValue: "20" } });
		// Binding attributes on the root make the export round-trippable.
		expect(root?.attributes).toContainEqual({
			key: "autocode.region.digest",
			value: { stringValue: trajectory.code.regionDigest },
		});
		// Scores ride as span events.
		expect(root?.events?.[0]?.name).toBe("autocode.score");
	});

	it("never exports raw sensitive payload values, only refs", () => {
		const runtime = createCaptureRuntime({ runKeyRef: "run-key://tenant-a" });
		const capture = runtime.captureInvocation({
			run: { id: "run-otlp-1", traceparent: FIXTURE_TRACEPARENT },
			method: {
				name: "classify",
				contractRef: "contract://classify@1.0.0",
				generatedRegion: classifierRegion(),
				regionDigest: classifierRegionDigest(),
			},
			payloads: { input: "billing invoice", email: "user@example.com" },
			sensitiveFields: ["email"],
			scores: [{ name: "reward", value: 0.8, source: "live-eval" }],
		});

		const serialized = JSON.stringify(toOtlpJson([capture.trajectory!]));
		expect(serialized).not.toContain("user@example.com");
		expect(serialized).toContain("autocode.payload_ref.email");
		expect(serialized).toContain("run://run-otlp-1/payloads/email");
		expect(serialized).toContain("billing invoice");
	});
});

describe("fromOtelSpans (round-trip)", () => {
	it("reproduces trajectories from our own export", () => {
		const { trajectories, skipped } = fromOtelSpans(toOtlpJson([trajectory]));

		expect(skipped).toEqual([]);
		expect(trajectories).toHaveLength(1);
		const recovered = trajectories[0]!;
		expect(validateTrajectory(recovered).ok).toBe(true);

		expect(recovered.id).toBe(trajectory.id);
		expect(recovered.traceparent).toBe(trajectory.traceparent);
		expect(recovered.run).toEqual(trajectory.run);
		expect(recovered.subject).toEqual(trajectory.subject);
		expect(recovered.code).toEqual(trajectory.code);
		expect(recovered.context?.session).toEqual(trajectory.context?.session);
		expect(recovered.context?.tags).toEqual(trajectory.context?.tags);
		expect(recovered.context?.environment).toBe("test");
		expect(recovered.scores).toEqual(trajectory.scores);
		expect(recovered.payloads["input"]?.value).toBe("billing invoice refund");

		expect(recovered.spans).toHaveLength(2);
		expect(recovered.spans.map((span) => span.id)).toEqual(trajectory.spans.map((span) => span.id));
		expect(recovered.spans[1]?.parentId).toBe(trajectory.spans[1]?.parentId);
		expect(recovered.spans[1]?.genAi?.requestModel).toBe("stub-classifier");
		expect(recovered.spans[1]?.genAi?.usage).toEqual({ inputTokens: 20, outputTokens: 5, totalTokens: 25 });
		expect(recovered.spans[0]?.status).toEqual({ code: "OK" });
		expect(recovered.usage?.inputTokens).toBe(20);
	});

	it("preserves sensitive payload classification across the round-trip", () => {
		const base = makeTrajectory({
			id: "t-class",
			input: "billing invoice",
			baselineLabel: "general-support",
			expectedLabel: "billing-support",
		});
		const withSecret = {
			...base,
			payloads: {
				...base.payloads,
				apiKey: {
					classification: "secret" as const,
					redaction: "encrypted" as const,
					encryptedRef: `run://${base.run.id}/payloads/apiKey`,
				},
			},
		};

		const { trajectories, skipped } = fromOtelSpans(toOtlpJson([withSecret]));

		expect(skipped).toEqual([]);
		expect(trajectories[0]?.payloads["apiKey"]).toEqual({
			classification: "secret",
			redaction: "encrypted",
			encryptedRef: `run://${base.run.id}/payloads/apiKey`,
		});
	});

	it("ingests foreign gen_ai.* spans via a bind() callback", () => {
		const foreign = {
			resourceSpans: [
				{
					resource: { attributes: [] },
					scopeSpans: [
						{
							scope: { name: "some-other-sdk" },
							spans: [
								{
									traceId: "ffffffffffffffffffffffffffffffff",
									spanId: "aaaaaaaaaaaaaaaa",
									name: "chat claude-sonnet-5",
									startTimeUnixNano: "1750000000000000000",
									endTimeUnixNano: "1750000001000000000",
									attributes: [
										{ key: "gen_ai.operation.name", value: { stringValue: "chat" } },
										{ key: "gen_ai.request.model", value: { stringValue: "claude-sonnet-5" } },
										{ key: "gen_ai.usage.input_tokens", value: { intValue: "11" } },
										{ key: "gen_ai.usage.output_tokens", value: { intValue: "4" } },
									],
									events: [],
								},
							],
						},
					],
				},
			],
		};

		const region = classifierRegion();
		const { trajectories, skipped } = fromOtelSpans(foreign, {
			bind: () => ({
				run: { id: "run-foreign-1" },
				subject: { method: "classify", contractRef: "contract://classify@1.0.0", generatedRegion: region },
				code: { regionDigest: classifierRegionDigest() },
				feedback: [{ kind: "text", text: "imported from foreign instrumentation" }],
			}),
		});

		expect(skipped).toEqual([]);
		expect(trajectories).toHaveLength(1);
		const recovered = trajectories[0]!;
		expect(validateTrajectory(recovered).ok).toBe(true);
		// Foreign span had no openinference.span.kind — heuristic marks it LLM.
		expect(recovered.spans[0]?.attributes["openinference.span.kind"]).toBe("LLM");
		expect(recovered.spans[0]?.genAi?.usage).toEqual({ inputTokens: 11, outputTokens: 4 });
	});

	it("reports unmappable traces instead of dropping them", () => {
		const { trajectories, skipped } = fromOtelSpans([
			{
				traceId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
				spanId: "bbbbbbbbbbbbbbbb",
				name: "orphan",
				attributes: [],
				events: [],
			},
		]);

		expect(trajectories).toEqual([]);
		expect(skipped).toHaveLength(1);
		expect(skipped[0]?.reason).toContain("no autocode.* binding");
	});
});
