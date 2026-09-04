import { describe, expect, it } from "vitest";

import { commitRewrite, revertRewrite } from "ts-autocode-rewrite";

import {
	defaultMinScore,
	defineTrainable,
	evaluatePromotionGate,
	type CandidatePatch,
} from "../src/index.js";
import { evaluateTrainable } from "../src/evaluation.js";
import { discoverInSource } from "../src/source.js";

const source = `class Router {
  route(input: string): string {
    "use training";
    return "old";
  }
}`;
const target = discoverInSource(source, "src/router.ts")[0]!;

function candidate(): CandidatePatch {
	return {
		id: "candidate",
		trainableId: defineTrainable("Router.route").id,
		engineId: "test",
		target,
		implementation: 'return "new";',
	};
}

describe("promotion", () => {
	it("gates with AgentV and reverts only an unchanged promoted method", async () => {
		const patch = candidate();
		const evaluated = await evaluateTrainable(defineTrainable(patch.trainableId), {
			tests: [{ id: "candidate", input: "route", assert: [{ type: "equals", value: "new" }] }],
			task: () => new Function(patch.implementation)() as string,
			outputDir: "test/output/agentv-promotion",
		});
		const decision = await evaluatePromotionGate({
			candidate: patch,
			evaluations: evaluated.evaluations.map((evaluation) => ({ ...evaluation, candidateId: patch.id })),
			conformance: true,
		});
		// The gate decides; the training-agnostic rewrite commit is only reached
		// once the consumer has checked it, mirroring the wired applier.
		expect(decision.promote).toBe(true);
		const committed = commitRewrite(source, patch);

		expect(committed.source).toContain('return "new";');
		expect(revertRewrite(committed.source, committed.snapshot)).toBe(source);
		expect(() => revertRewrite(committed.source.replace('return "new";', 'return "changed";'), committed.snapshot))
			.toThrow("changed before revert");
	});

	it("runs configured extension gates after the standard set", async () => {
		const patch = candidate();
		const evaluated = await evaluateTrainable(defineTrainable(patch.trainableId), {
			tests: [{ id: "candidate", input: "route", assert: [{ type: "equals", value: "new" }] }],
			task: () => new Function(patch.implementation)() as string,
			outputDir: "test/output/agentv-promotion-gates",
		});
		const decision = await evaluatePromotionGate({
			candidate: patch,
			evaluations: evaluated.evaluations.map((evaluation) => ({ ...evaluation, candidateId: patch.id })),
			conformance: true,
			gates: [
				({ candidate: subject }) => subject.implementation.includes("eval(") ? "implementation must not call eval" : undefined,
				() => ["no deploys on friday"],
			],
		});

		expect(decision.promote).toBe(false);
		expect(decision.failures).toEqual(["no deploys on friday"]);
	});

	it("rejects evaluations bound to another trainable", async () => {
		const evaluated = await evaluateTrainable(defineTrainable("Router.other"), {
			tests: [{ id: "other", input: "route", assert: [{ type: "equals", value: "old" }] }],
			task: () => "old",
			outputDir: "test/output/agentv-promotion-mismatch",
		});
		const decision = await evaluatePromotionGate({
			candidate: candidate(),
			evaluations: evaluated.evaluations,
			conformance: true,
		});

		expect(decision.promote).toBe(false);
		expect(decision.failures).toContain("AgentV evaluations must match the candidate trainable id");
	});

	it("never treats baseline evaluations as candidate evidence", async () => {
		const baseline = await evaluateTrainable(defineTrainable("Router.route"), {
			tests: [{ id: "baseline", input: "route", assert: [{ type: "equals", value: "old" }] }],
			task: () => "old",
			outputDir: "test/output/agentv-promotion-baseline",
		});
		const decision = await evaluatePromotionGate({
			candidate: candidate(),
			evaluations: baseline.evaluations,
			conformance: true,
		});

		expect(decision.promote).toBe(false);
		expect(decision.failures).toContain("AgentV evaluations must be run against the candidate");
	});
});

describe("threshold validation messages", () => {
	// A user who passes a bad threshold wants to know the range, not Zod's type
	// vocabulary. `minScore: Infinity` used to report "expected number, received
	// number", because the base schema rejected it before the .finite() message
	// could apply. Found by a property test over non-unit-interval doubles.
	const bad: ReadonlyArray<readonly [string, unknown]> = [
		["negative", -0.5],
		["above one", 1.5],
		["positive infinity", Number.POSITIVE_INFINITY],
		["negative infinity", Number.NEGATIVE_INFINITY],
		["NaN", Number.NaN],
		["a string", "0.5"],
		["a boolean", true],
		["an object", {}],
	];

	it.each(bad)("reports the range for %s", async (_label, value) => {
		const promise = evaluatePromotionGate({
			candidate: candidate(), evaluations: [], conformance: true, minScore: value as number,
		});
		await expect(promise).rejects.toThrow("minScore must be between 0 and 1");
	});

	it("names the offending setting, not a generic one", async () => {
		await expect(evaluatePromotionGate({
			candidate: candidate(), evaluations: [], conformance: true, minPassRate: 2,
		})).rejects.toThrow("minPassRate must be between 0 and 1");
	});

	it("treats null and undefined as unset, applying the default", async () => {
		// `minScore ?? defaultMinScore` coalesces both. Neither is type-valid, so
		// this pins the behavior rather than endorsing it as an input.
		for (const value of [undefined, null]) {
			// `exactOptionalPropertyTypes` forbids passing an explicit undefined,
			// which is the point: neither spelling is type-valid, so this pins
			// runtime behavior rather than endorsing either as an input.
			const input = { candidate: candidate(), evaluations: [], conformance: true, minScore: value };
			const decision = await evaluatePromotionGate(input as unknown as Parameters<typeof evaluatePromotionGate>[0]);
			expect(decision.failures.some((failure) => failure.includes(`below ${defaultMinScore}`))).toBe(true);
		}
	});

	it("accepts the closed interval's endpoints", async () => {
		for (const value of [0, 1]) {
			await expect(evaluatePromotionGate({
				candidate: candidate(), evaluations: [], conformance: true, minScore: value, minPassRate: value,
			})).resolves.toBeDefined();
		}
	});
});
