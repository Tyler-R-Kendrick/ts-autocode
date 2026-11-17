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
	it("names the modules whose imports actually wire the runtime", () => {
		expect(manifest.sideEffects).toEqual(["./dist/cli-main.js", "./dist/index.js", "./dist/register.js"]);
	});
});

describe("evolution kill switch", () => {
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
			expect(() => registerLoadHook({ load: (url, context, nextLoad) => nextLoad(url, context) }))
				.toThrow(/@trainable\(\) decorator/);
		} finally {
			(nodeModule as { registerHooks?: unknown }).registerHooks = original;
		}
	});
});
