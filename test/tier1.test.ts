import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createHarnessLoop } from "../src/providers/harness.js";
import nodeModule from "node:module";

import { evolutionEnabled, evolveVariable } from "../src/evolve.js";
import { canRegisterLoadHook, registerLoadHook } from "../src/load-hook.js";
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
		expect(manifest.sideEffects).toEqual(["./dist/cli-main.js", "./dist/index.js", "./dist/register.js"]);
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

	it("lists every value it would have accepted, and quotes the one it got", () => {
		// Failing closed is only half of it: a user who typed the wrong thing has
		// to be told what the right thing is, or the kill switch is a dead end.
		// Asserting only /must be one of/ let the list itself go unchecked.
		const message = (() => {
			try {
				evolutionEnabled("nope");
			} catch (error) {
				return (error as Error).message;
			}
			throw new Error("evolutionEnabled accepted an unrecognized value");
		})();

		for (const accepted of ["1", "true", "on", "yes", "enabled", "0", "false", "off", "no", "disabled"]) {
			expect(message).toContain(accepted);
		}
		expect(message).toContain(", ");
		expect(message).toContain('received "nope"');
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

describe("ts-autocode/register on older Node", () => {
	// CI on Node 20.20.2 surfaced `TypeError: registerHooks is not a function`
	// from src/register.ts. `module.registerHooks` is the synchronous in-thread
	// loader API and Node 20 does not have it, so the documented zero-config
	// entry point -- `node --import ts-autocode/register` -- crashed on the
	// minimum version `engines` declares. Nothing imported that module in a
	// test before, which is why it went unnoticed.
	it("installs the hook when the runtime provides it", () => {
		expect(canRegisterLoadHook()).toBe(typeof nodeModule.registerHooks === "function");
		if (!canRegisterLoadHook()) return;
		const installed: unknown[] = [];
		const original = nodeModule.registerHooks;
		try {
			(nodeModule as { registerHooks?: unknown }).registerHooks = (hooks: unknown) => installed.push(hooks);
			registerLoadHook({ load: (url, context, nextLoad) => nextLoad(url, context) });
			expect(installed).toHaveLength(1);
		} finally {
			(nodeModule as { registerHooks?: unknown }).registerHooks = original;
		}
	});

	it("explains the requirement instead of surfacing a TypeError", () => {
		const original = nodeModule.registerHooks;
		try {
			delete (nodeModule as { registerHooks?: unknown }).registerHooks;
			expect(canRegisterLoadHook()).toBe(false);
			expect(() => registerLoadHook({ load: (url, context, nextLoad) => nextLoad(url, context) }))
				.toThrow(/needs module\.registerHooks/);
			// The message must say what still works and what to do, not just fail.
			expect(() => registerLoadHook({ load: (url, context, nextLoad) => nextLoad(url, context) }))
				.toThrow(/@trainable\(\) decorator/);
		} finally {
			(nodeModule as { registerHooks?: unknown }).registerHooks = original;
		}
	});
});
