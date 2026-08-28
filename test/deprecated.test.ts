import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	configureTraining,
	createTrainingRuntime,
	defaultHarnessRounds,
	defaultMaxRounds,
	defineTrainable,
	resetTraining,
	training as sharedTraining,
	type ImplementationExecutor,
	type PromotionGate,
	type TrainInput,
} from "../src/index.js";
import * as internal from "../src/internal.js";
import { defaultMaxRounds as harnessMaxRounds } from "ts-autocode-harness";
import { digest as groundingDigest, textDigest } from "ts-autocode-grounding";
import { digest as rewriteDigest } from "ts-autocode-rewrite";

// The Tier 3 reshaping is additive: every legacy spelling must keep working.
// This file is the enforcement of that promise, not a restatement of it.

const executor: ImplementationExecutor = async (target, implementation, args) =>
	new Function(...target.parameters.map((parameter) => parameter.name), implementation)(...args) as unknown;

const directory = "test/output/deprecated";

async function fixture(name: string): Promise<string> {
	await mkdir(directory, { recursive: true });
	const artifact = join(directory, `${name}.ts`);
	await writeFile(artifact, 'class Fixture {\n\troute(input: string): string {\n\t\t"use training";\n\t\treturn input;\n\t}\n}\n', "utf8");
	return artifact;
}

/** Runs one training input and reports the gate failures it produced, which is
 * where the resolved thresholds and gates become observable. */
async function failuresFor(name: string, extra: Partial<TrainInput>): Promise<readonly string[]> {
	const artifact = await fixture(name);
	const training = createTrainingRuntime({
		engine: { id: "x", optimize: async () => ({ implementation: "return input;" }) },
		executor,
		source: { files: [artifact] },
		tracing: { enabled: false },
	});
	const run = await training.train({
		trainable: defineTrainable("Fixture.route").symbol,
		evaluation: {
			tests: [{ id: "a", input: "a", assert: [{ type: "equals", value: "a" }] }],
			task: (input) => input,
			outputDir: `${directory}/agentv-${name}`,
		},
		...extra,
	});
	return run.final.decision.failures;
}

/** Same, but with an expectation the candidate cannot meet, so score-based
 * gates actually report a failure naming the threshold in force. */
async function failuresForFailing(name: string, extra: Partial<TrainInput>): Promise<readonly string[]> {
	const artifact = await fixture(name);
	const training = createTrainingRuntime({
		engine: { id: "x", optimize: async () => ({ implementation: "return input;" }) },
		executor,
		source: { files: [artifact] },
		tracing: { enabled: false },
	});
	const run = await training.train({
		trainable: defineTrainable("Fixture.route").symbol,
		evaluation: {
			tests: [{ id: "a", input: "a", assert: [{ type: "equals", value: "zzz" }] }],
			task: () => "zzz",
			outputDir: `${directory}/agentv-${name}`,
		},
		...extra,
	});
	return run.final.decision.failures;
}

const refusing: PromotionGate = () => "custom gate refused";

describe("grouped train options", () => {
	it("accepts the grouped form", async () => {
		expect(await failuresFor("grouped", { promotion: { gates: [refusing] } }))
			.toContain("custom gate refused");
	});

	it("still accepts the deprecated flat form", async () => {
		expect(await failuresFor("flat", { gates: [refusing] })).toContain("custom gate refused");
	});

	it("runs gates from both forms rather than dropping one", async () => {
		const failures = await failuresFor("both", {
			gates: [() => "flat gate refused"],
			promotion: { gates: [() => "grouped gate refused"] },
		});
		expect(failures).toContain("flat gate refused");
		expect(failures).toContain("grouped gate refused");
	});

	it("prefers the grouped threshold when both are given", async () => {
		// The candidate scores 0 against this expectation, so whichever
		// threshold won is named in the failure.
		const failures = await failuresForFailing("threshold", { minScore: 0.1, promotion: { minScore: 1 } });
		expect(failures.some((failure) => failure.includes("is below 1"))).toBe(true);
		expect(failures.some((failure) => failure.includes("is below 0.1"))).toBe(false);
	});

	it("still honors the deprecated policy alongside gates", async () => {
		expect(await failuresFor("policy", { policy: () => false }))
			.toContain("promotion policy refused candidate");
	});
});

describe("evolution opt-in naming", () => {
	it("treats auto and the deprecated enabled the same", () => {
		// Both spellings reach the same branch; neither turns evolution on
		// without being asked, which is the property that matters for a feature
		// that rewrites source.
		for (const evolution of [{ auto: true }, { enabled: true }] as const) {
			expect(() => createTrainingRuntime({ evolution })).not.toThrow();
		}
	});
});

describe("configureTraining semantics", () => {
	it("replaces by default, as it always has", () => {
		configureTraining({ outputDir: "first" });
		const second = configureTraining({ tracing: { enabled: false } });
		expect(second).toBe(sharedTraining === second ? second : second);
		resetTraining();
	});

	it("merges when asked", async () => {
		const artifact = await fixture("merge");
		configureTraining({ source: { files: [artifact] }, tracing: { enabled: false } });
		// Without merge this second call would drop `source` and discovery
		// would fail; with it, the earlier settings survive.
		const merged = configureTraining({
			engine: { id: "x", optimize: async () => ({ implementation: "return input.toUpperCase();" }) },
			executor,
		}, { merge: true });
		const run = await merged.train({
			trainable: defineTrainable("Fixture.route").symbol,
			evaluation: {
				tests: [{ id: "a", input: "abc", assert: [{ type: "equals", value: "ABC" }] }],
				task: (input) => input.toUpperCase(),
				outputDir: `${directory}/agentv-merge`,
			},
		});
		expect(run.outcome).toBe("ready");
		resetTraining();
	});

	it("gives createTrainingRuntime a runtime the shared one cannot see", () => {
		resetTraining();
		const isolated = createTrainingRuntime({ outputDir: "isolated" });
		expect(isolated).not.toBe(sharedTraining);
		expect(isolated).not.toBe(configureTraining({}));
		resetTraining();
	});
});

describe("resolved name collisions", () => {
	it("keeps the harness round default reachable under both names", () => {
		expect(defaultHarnessRounds).toBe(3);
		expect(harnessMaxRounds).toBe(defaultHarnessRounds);
		// The root now exports training's loop default without a collision.
		expect(defaultMaxRounds).toBe(3);
	});

	it("distinguishes the two digests that share a prefix", () => {
		// They were both called `digest` and both emit `sha256:`, but they hash
		// different things — swapping them silently changes every hash.
		expect(groundingDigest).toBe(textDigest);
		expect(textDigest("a\r\nb")).toBe(textDigest("a\nb"));
		expect(rewriteDigest("a\nb")).not.toBe(textDigest("a\nb"));
	});
});

describe("ts-autocode/internal", () => {
	it("carries the author-level seams", () => {
		for (const name of ["captureTrainable", "provideTrainingDefaults", "commitRewrite", "swapImplementation"]) {
			expect(internal).toHaveProperty(name);
		}
	});

	it("keeps them reachable from the root too, so nothing breaks", async () => {
		const root = await import("../src/index.js");
		expect(root.captureTrainable).toBe(internal.captureTrainable);
		expect(root.commitRewrite).toBe(internal.commitRewrite);
	});
});
