import { describe, expect, it } from "vitest";

import {
	PromotionGateParseError,
	evaluatePromotionGate,
	parseEvalResult,
	parsePromotionThresholds,
	promotionEventNames,
} from "../src/index.js";

const evalResult = parseEvalResult({
	rubricRef: "rubric://classify@1.0.0",
	source: "live-eval",
	sampleCount: 5,
	scores: { categoryCorrect: 0.96, piiSafe: 1 },
});

const thresholds = parsePromotionThresholds({
	minSamples: 3,
	metricFloors: { categoryCorrect: 0.9, piiSafe: 1 },
});

describe("boundary parsers", () => {
	it("rejects scores outside [0, 1]", () => {
		expect(() =>
			parseEvalResult({ rubricRef: "r", source: "s", sampleCount: 1, scores: { quality: 1.2 } }),
		).toThrowError(PromotionGateParseError);
	});

	it("rejects a negative min-samples gate", () => {
		expect(() => parsePromotionThresholds({ minSamples: -1, metricFloors: {} })).toThrowError(
			PromotionGateParseError,
		);
	});

	it("freezes parsed values", () => {
		expect(Object.isFrozen(evalResult)).toBe(true);
		expect(Object.isFrozen(evalResult.scores)).toBe(true);
	});
});

describe("evaluatePromotionGate", () => {
	it("promotes when all three lenses are green", () => {
		const decision = evaluatePromotionGate({
			candidateId: "candidate-1",
			conformance: true,
			policy: true,
			evalResult,
			thresholds,
			championId: "champion-current",
		});

		expect(decision.outcome).toBe("promote");
		expect(decision.passed).toEqual({ conformance: true, eval: true, policy: true });
		expect(decision.failures).toEqual([]);
		expect(decision.championChallenger).toEqual({
			championId: "champion-current",
			challengerId: "candidate-1",
		});
	});

	it("refuses when conformance is red, recording the lens", () => {
		const decision = evaluatePromotionGate({
			candidateId: "candidate-1",
			conformance: false,
			policy: true,
			evalResult,
			thresholds,
		});

		expect(decision.outcome).toBe("refuse");
		expect(decision.passed.conformance).toBe(false);
		expect(decision.failures).toContain("conformance: hard contract not green");
	});

	it("refuses on a metric below its floor", () => {
		const decision = evaluatePromotionGate({
			candidateId: "candidate-1",
			conformance: true,
			policy: true,
			evalResult: parseEvalResult({
				rubricRef: "rubric://classify@1.0.0",
				source: "live-eval",
				sampleCount: 5,
				scores: { categoryCorrect: 0.7, piiSafe: 1 },
			}),
			thresholds,
		});

		expect(decision.outcome).toBe("refuse");
		expect(decision.passed.eval).toBe(false);
		expect(decision.failures).toContain("eval: categoryCorrect 0.7 below floor 0.9");
	});

	it("refuses on a missing metric and on too few samples", () => {
		const decision = evaluatePromotionGate({
			candidateId: "candidate-1",
			conformance: true,
			policy: true,
			evalResult: parseEvalResult({
				rubricRef: "rubric://classify@1.0.0",
				source: "live-eval",
				sampleCount: 1,
				scores: { categoryCorrect: 0.99 },
			}),
			thresholds,
		});

		expect(decision.outcome).toBe("refuse");
		expect(decision.failures).toContain("eval: 1 samples below min 3");
		expect(decision.failures).toContain("eval: metric piiSafe missing from eval result");
	});

	it("refuses when policy disallows even with perfect evals", () => {
		const decision = evaluatePromotionGate({
			candidateId: "candidate-1",
			conformance: true,
			policy: false,
			evalResult,
			thresholds,
		});

		expect(decision.outcome).toBe("refuse");
		expect(decision.passed).toEqual({ conformance: true, eval: true, policy: false });
	});
});

describe("promotionEventNames", () => {
	it("maps promote to the training and impl facts", () => {
		const decision = evaluatePromotionGate({
			candidateId: "candidate-1",
			conformance: true,
			policy: true,
			evalResult,
			thresholds,
		});

		expect(promotionEventNames(decision)).toEqual(["training.Promoted", "impl.Promoted"]);
	});

	it("maps refuse to the eval-gate failure fact", () => {
		const decision = evaluatePromotionGate({
			candidateId: "candidate-1",
			conformance: false,
			policy: true,
			evalResult,
			thresholds,
		});

		expect(promotionEventNames(decision)).toEqual(["eval.GateFailed"]);
	});
});
