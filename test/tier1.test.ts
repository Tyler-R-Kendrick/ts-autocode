import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createHarnessLoop } from "../src/providers/harness.js";
import { evolutionEnabled, evolveVariable } from "../src/register.js";
import { defaultMinPassRate, defaultMinScore } from "ts-autocode-training";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
	sideEffects: unknown;
};

describe("sideEffects declaration", () => {
	// `src/index.ts` registers the Ax engine, executor, harness loop and
	// promotion applier at import time, and `src/register.ts` is entirely side
	// effects. Declaring `false` let a tree-shaking bundler drop that wiring and
	// leave a consumer with "no training engine is configured" after importing
	// the package that configures it.
	it("names the modules whose imports actually wire the runtime", () => {
		expect(manifest.sideEffects).toEqual(["./dist/index.js", "./dist/register.js"]);
	});
});

describe("evolution kill switch", () => {
	// Evolution rewrites the user's source files. The switch used to disable
	// only "0", "false" and "off", so TS_AUTOCODE_EVOLVE=no enabled it.
	it("stays enabled when unset, because loading the hook is the opt-in", () => {
		expect(evolutionEnabled(undefined)).toBe(true);
		expect(evolutionEnabled("")).toBe(true);
	});

	it.each(["0", "false", "off", "no", "disabled", "OFF", " no "])("disables on %j", (value) => {
		expect(evolutionEnabled(value)).toBe(false);
	});

	it.each(["1", "true", "on", "yes", "enabled"])("enables on %j", (value) => {
		expect(evolutionEnabled(value)).toBe(true);
	});

	it("refuses an unrecognized value rather than guessing consent", () => {
		expect(() => evolutionEnabled("nope")).toThrow(evolveVariable);
		expect(() => evolutionEnabled("maybe")).toThrow(/must be one of/);
	});
});

describe("promotion thresholds", () => {
	it("exports the defaults that were inline literals", () => {
		expect(defaultMinScore).toBe(0.8);
		expect(defaultMinPassRate).toBe(1);
	});

	// promotionRubric() is read verbatim by the harness judge. It used to emit
	// the literal string "evaluation default" in place of the real threshold.
	it("names resolved numbers in the rubric handed to the judge", async () => {
		const rubrics: string[] = [];
		const { configureTraining } = await import("ts-autocode-training");
		const training = configureTraining({
			engine: { id: "rubric-test", optimize: async () => ({ implementation: "return input;" }) },
			loop: async (input) => {
				rubrics.push(input.rubric);
				return { outcome: "exhausted", rounds: [] };
			},
			source: { files: [`${repoRoot}test/fixtures/rubric.ts`] },
			tracing: { enabled: false },
		});
		await training.train({
			trainable: (await import("ts-autocode-training")).defineTrainable("Fixture.route").symbol,
			evaluation: {
				tests: [{ id: "a", input: "a", assert: [{ type: "equals", value: "a" }] }],
				task: (input) => input,
				outputDir: "test/output/rubric",
			},
		}).catch(() => undefined);
		expect(rubrics[0]).toContain(`Minimum evaluation score: ${defaultMinScore}.`);
		expect(rubrics[0]).toContain(`Minimum evaluation pass rate: ${defaultMinPassRate}.`);
		expect(rubrics[0]).not.toContain("evaluation default");
	});
});

describe("harness loop fan-out", () => {
	// TrainInput.fanOut was documented as a first-class knob but the default
	// loop pinned one candidate per round and ignored it. Refusing is honest;
	// silently doing something else is not.
	it("refuses a fanOut it cannot honor instead of ignoring it", async () => {
		await expect(createHarnessLoop()({
			trainableId: "Fixture.route" as never,
			objective: "x",
			rubric: "x",
			outputDir: "test/output/fanout",
			fanOut: 3,
			propose: () => { throw new Error("must not propose"); },
			review: () => { throw new Error("must not review"); },
		})).rejects.toThrow(/cannot honor fanOut 3/);
	});

	it("accepts the fan-out it does support", async () => {
		const run = createHarnessLoop()({
			trainableId: "Fixture.route" as never,
			objective: "x",
			rubric: "x",
			outputDir: "test/output/fanout",
			fanOut: 1,
			maxRounds: 1,
			propose: async () => { throw new Error("proposed"); },
			review: async () => { throw new Error("must not review"); },
		});
		await expect(run).rejects.toThrow("proposed");
	});
});
