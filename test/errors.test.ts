import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	configureTraining,
	defineTrainable,
	EngineNotConfiguredError,
	ExecutorNotConfiguredError,
	InsufficientTracesError,
	InvalidSettingsError,
	InvalidTrainableIdentityError,
	isTsAutocodeError,
	LoopCapabilityError,
	PromotionRejectedError,
	trainable,
	TrainingIncompleteError,
	TsAutocodeError,
	type ImplementationExecutor,
	type TrainingEvent,
} from "../src/index.js";
import { createHarnessLoop } from "../src/providers/harness.js";

const executor: ImplementationExecutor = async (target, implementation, args) =>
	new Function(...target.parameters.map((parameter) => parameter.name), implementation)(...args) as unknown;

const directory = "test/output/errors";

async function fixture(name: string, body = '\t\t"use training";\n\t\treturn input;'): Promise<string> {
	await mkdir(directory, { recursive: true });
	const artifact = join(directory, `${name}.ts`);
	await writeFile(artifact, `class Fixture {\n\troute(input: string): string {\n${body}\n\t}\n}\n`, "utf8");
	return artifact;
}

describe("typed errors", () => {
	it("recognizes the whole family through one check", () => {
		const errors = [
			new EngineNotConfiguredError(),
			new InsufficientTracesError(2, 1),
			new InvalidTrainableIdentityError("bad"),
			new LoopCapabilityError("nope"),
		];
		for (const error of errors) {
			expect(isTsAutocodeError(error)).toBe(true);
			expect(error).toBeInstanceOf(TsAutocodeError);
			expect(error).toBeInstanceOf(Error);
			expect(typeof error.code).toBe("string");
		}
		expect(isTsAutocodeError(new Error("unrelated"))).toBe(false);
		expect(new Error("unrelated")).not.toBeInstanceOf(TsAutocodeError);
	});

	it("keeps subclass instanceof precise", () => {
		expect(new EngineNotConfiguredError()).not.toBeInstanceOf(ExecutorNotConfiguredError);
		expect(new EngineNotConfiguredError()).toBeInstanceOf(EngineNotConfiguredError);
	});

	// Errors that were TypeError/SyntaxError stay that way, so a consumer
	// catching them today keeps working.
	it("preserves the builtin prototypes consumers may already catch", () => {
		const identity = new InvalidTrainableIdentityError("bad");
		expect(identity).toBeInstanceOf(TypeError);
		expect(identity).toBeInstanceOf(TsAutocodeError);
		expect(new InvalidSettingsError("bad")).toBeInstanceOf(TypeError);
	});

	it("carries the facts a caller would otherwise re-derive", () => {
		const traces = new InsufficientTracesError(3, 1);
		expect(traces.required).toBe(3);
		expect(traces.found).toBe(1);
		expect(traces.code).toBe("insufficient_traces");

		const rejected = new PromotionRejectedError("cand-1", {
			candidateId: "cand-1", promote: false, failures: ["nope"], meanScore: 0, passRate: 0,
		});
		expect(rejected.failures).toEqual(["nope"]);

		expect(TrainingIncompleteError.noRounds("stalled").outcome).toBe("stalled");
	});

	it("preserves every message string byte for byte", () => {
		expect(new EngineNotConfiguredError().message)
			.toBe('no training engine is configured; import "ts-autocode" for the Ax default or set TrainingSettings.engine');
		expect(new ExecutorNotConfiguredError().message)
			.toBe('candidate execution requires an executor; import "ts-autocode" or set TrainingSettings.executor');
		expect(new InsufficientTracesError(2, 1).message)
			.toBe("training from captured traffic requires 2 distinct successful runtime traces; found 1");
		expect(new InsufficientTracesError(1, 0).message)
			.toBe("training from captured traffic requires 1 distinct successful runtime trace; found 0");
		expect(new PromotionRejectedError("cand-1").message)
			.toBe("candidate has not passed the promotion gate: cand-1");
	});

	it("surfaces setting validation as a library error, not a ZodError", async () => {
		const artifact = await fixture("settings");
		const training = configureTraining({
			engine: { id: "x", optimize: async () => ({ implementation: "return input;" }) },
			executor,
			source: { files: [artifact] },
			tracing: { enabled: false },
		});
		const failure = await training.train({
			trainable: defineTrainable("Fixture.route").symbol,
			minScore: 1.5,
			evaluation: {
				tests: [{ id: "a", input: "a", assert: [{ type: "equals", value: "a" }] }],
				task: (input) => input,
				outputDir: `${directory}/agentv-settings`,
			},
		}).catch((error: unknown) => error);
		expect(isTsAutocodeError(failure)).toBe(true);
		expect((failure as InvalidSettingsError).code).toBe("invalid_settings");
		expect((failure as Error).message).toContain("minScore must be between 0 and 1");
	});

	it("throws a typed refusal from the loop that cannot fan out", async () => {
		await expect(createHarnessLoop()({
			trainableId: "Fixture.route" as never,
			objective: "x",
			rubric: "x",
			outputDir: `${directory}/fanout`,
			fanOut: 4,
			propose: () => { throw new Error("unreachable"); },
			review: () => { throw new Error("unreachable"); },
		})).rejects.toBeInstanceOf(LoopCapabilityError);
	});

	it("rejects a non-symbol decorator identity as a TypeError, as before", () => {
		expect(() => trainable("Router.route" as never)).toThrow(TypeError);
		expect(() => trainable("Router.route" as never)).toThrow(InvalidTrainableIdentityError);
	});
});

describe("activation readiness", () => {
	it("reports why a run cannot be applied without throwing", async () => {
		const artifact = await fixture("readiness");
		const training = configureTraining({
			engine: { id: "x", optimize: async () => ({ implementation: "return input;" }) },
			executor,
			source: { files: [artifact] },
			tracing: { enabled: false },
			// A loop that never promotes, so the run ends unready.
			loop: async (input) => {
				const candidate = await input.propose({ round: 1, slot: 1, feedback: [] });
				const review = await input.review(candidate, { label: "candidate-1" });
				return { outcome: "exhausted", rounds: [{ round: 1, candidate, ...review }] };
			},
		});
		const run = await training.train({
			trainable: defineTrainable("Fixture.route").symbol,
			evaluation: {
				tests: [{ id: "a", input: "a", assert: [{ type: "equals", value: "zzz" }] }],
				task: (input) => input,
				outputDir: `${directory}/agentv-readiness`,
			},
		});

		const readiness = run.canActivate();
		expect(readiness.ready).toBe(false);
		if (!readiness.ready) {
			expect(readiness.outcome).toBe("exhausted");
			expect(readiness.failures.length).toBeGreaterThan(0);
		}
		// And the throwing path agrees with it.
		await expect(run.activate()).rejects.toBeInstanceOf(PromotionRejectedError);
	});

	it("reports readiness for a run that did promote", async () => {
		const artifact = await fixture("promoted");
		const training = configureTraining({
			engine: { id: "x", optimize: async () => ({ implementation: "return input.toUpperCase();" }) },
			executor,
			source: { files: [artifact] },
			tracing: { enabled: false },
		});
		const run = await training.train({
			trainable: defineTrainable("Fixture.route").symbol,
			evaluation: {
				tests: [{ id: "a", input: "abc", assert: [{ type: "equals", value: "ABC" }] }],
				task: (input) => input.toUpperCase(),
				outputDir: `${directory}/agentv-promoted`,
			},
		});
		expect(run.outcome).toBe("ready");
		expect(run.canActivate()).toEqual({ ready: true });
	});
});

describe("background events", () => {
	it("reports evolution lifecycle, and still calls the deprecated onError", async () => {
		const artifact = await fixture("events");
		const events: TrainingEvent[] = [];
		const legacy: Array<[unknown, string]> = [];
		const training = configureTraining({
			engine: { id: "x", optimize: async () => { throw new Error("engine down"); } },
			executor,
			source: { files: [artifact] },
			tracing: { enabled: false },
			onEvent: (event) => events.push(event),
			onError: (error, phase) => legacy.push([error, phase]),
			evolution: { enabled: true, minTraces: 1, evaluation: { outputDir: `${directory}/agentv-events` } },
		});

		const { captureTrainable } = await import("../src/index.js");
		captureTrainable("Fixture.route", "route", undefined, (input: string) => input, ["abc"]);
		await training.flush();
		// Evolution runs detached; give its microtask chain a turn to settle.
		for (let attempt = 0; attempt < 50 && !events.some((e) => e.type === "evolution.failed"); attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}

		expect(events.map((event) => event.type)).toContain("evolution.started");
		// The sad path documented in the README now has a test.
		expect(events.map((event) => event.type)).toContain("evolution.failed");
		expect(legacy.some(([, phase]) => phase === "evolve")).toBe(true);
	});
});
