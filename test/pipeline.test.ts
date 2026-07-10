import { describe, expect, it } from "vitest";

// The full code-evolution loop, end to end: optimize → screen offline →
// three-lens gate → champion/challenger promote → revert. Mirrors the flow
// the pieces are designed to compose into.
import {
	evaluatePromotionGate,
	parseEvalResult,
	parsePromotionThresholds,
	promoteCandidate,
	promotionEventNames,
	revertPromotion,
	runBuiltInOptoTrainingRun,
} from "../src/index.js";
import {
	FIXTURE_TS,
	classifierRegion,
	classifierSource,
	completeProvenance,
	heldOutTrajectories,
	makeOptimizeRequest,
} from "./fixtures.js";

const thresholds = parsePromotionThresholds({
	minSamples: 3,
	metricFloors: { categoryCorrect: 0.9, piiSafe: 1 },
});

function liveEval(scores: Record<string, number>) {
	return parseEvalResult({
		rubricRef: "rubric://classify@1.0.0",
		source: "live-eval",
		sampleCount: 3,
		scores,
	});
}

describe("code-evolution pipeline", () => {
	it("optimizes, gates, promotes, and can revert", () => {
		const source = classifierSource();
		const region = classifierRegion(source);

		// 1. Offline training run: candidate must beat baseline on held-out data.
		const run = runBuiltInOptoTrainingRun({
			request: makeOptimizeRequest({ generatedRegion: region }),
			heldOutTrajectories: heldOutTrajectories(),
		});
		expect(run.outcome).toBe("ready-for-gate");
		const candidate = run.candidate;
		if (candidate === null) throw new Error("expected candidate");

		// 2. Three-lens gate over live/shadow eval results.
		const decision = evaluatePromotionGate({
			candidateId: candidate.id,
			conformance: true,
			policy: true,
			evalResult: liveEval({ categoryCorrect: 0.96, piiSafe: 1 }),
			thresholds,
			championId: "champion-current",
		});
		expect(decision.outcome).toBe("promote");
		expect(promotionEventNames(decision)).toEqual(["training.Promoted", "impl.Promoted"]);

		// 3. Champion/challenger promotion applies the patch inside the region.
		const promoted = promoteCandidate({
			source,
			region,
			candidate,
			gate: { effect: "certify", certified: true, reason: "three-lens green" },
			provenance: completeProvenance(),
			environment: "preview",
			riskClass: "low",
			ts: FIXTURE_TS,
		});
		expect(promoted.effect).toBe("auto-applied");
		expect(promoted.source).toContain('return "billing-support";');
		expect(promoted.source).toContain("// autocode:generated-region begin region=classify-body");
		expect(promoted.source).toContain("handWrittenGuard = true");

		// 4. Revert restores the pre-promotion source from the event log.
		const reverted = revertPromotion({
			source: promoted.source,
			events: promoted.events,
			candidateId: candidate.id,
		});
		expect(reverted.source).toBe(source);
	});

	it("a refused gate never reaches promotion", () => {
		const run = runBuiltInOptoTrainingRun({
			request: makeOptimizeRequest(),
			heldOutTrajectories: heldOutTrajectories(),
		});
		const candidate = run.candidate;
		if (candidate === null) throw new Error("expected candidate");

		const decision = evaluatePromotionGate({
			candidateId: candidate.id,
			conformance: true,
			policy: true,
			evalResult: liveEval({ categoryCorrect: 0.7, piiSafe: 1 }),
			thresholds,
		});

		expect(decision.outcome).toBe("refuse");
		expect(promotionEventNames(decision)).toEqual(["eval.GateFailed"]);
	});
});
