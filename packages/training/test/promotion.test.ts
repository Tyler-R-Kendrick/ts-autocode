import { describe, expect, it } from "vitest";

import { promoteCandidate, revertPromotion } from "ts-autocode-rewrite";

import {
	defineTrainable,
	configureTraining,
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

const functionExecutor = async (
	target: { readonly parameters: readonly { readonly name: string }[] },
	implementation: string,
	args: readonly unknown[],
) => new Function(...target.parameters.map((parameter) => parameter.name), implementation)(...args) as unknown;

describe("promotion", () => {
	it("gates with AgentV and reverts only an unchanged promoted method", async () => {
		const patch = candidate();
		const evaluated = await configureTraining({ executor: functionExecutor }).evaluateCandidate(patch, {
			tests: [{ id: "candidate", input: "route", assert: [{ type: "equals", value: "new" }] }],
			outputDir: "test/output/agentv-promotion",
		});
		const decision = await evaluatePromotionGate({
			candidate: patch,
			evaluations: evaluated.evaluations,
			conformance: true,
		});
		const promoted = promoteCandidate({ source, candidate: patch, decision });

		expect(promoted.source).toContain('return "new";');
		expect(revertPromotion(promoted.source, promoted.snapshot)).toBe(source);
		expect(() => revertPromotion(promoted.source.replace('return "new";', 'return "changed";'), promoted.snapshot))
			.toThrow("changed before revert");
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
