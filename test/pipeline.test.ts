import { describe, expect, it } from "vitest";

// The full code-evolution loop, end to end: capture with trainable() →
// optimize (with the loop) → screen offline → three-lens gate →
// champion/challenger promote → revert. Mirrors Trace's declare/forward/
// optimize workflow with the governance additions bolted on.
import {
	OPTIMIZE_REQUEST_SCHEMA,
	type OptimizeRequest,
	createBuiltInOptoEngine,
	createCaptureRuntime,
	evaluatePromotionGate,
	parseEvalResult,
	parsePromotionThresholds,
	promoteCandidate,
	promotionEventNames,
	revertPromotion,
	runTrainingRun,
	runOptimizationLoop,
	trainable,
} from "../src/index.js";
import {
	FIXTURE_TRACEPARENT,
	FIXTURE_TS,
	classifierRegion,
	classifierSource,
	completeProvenance,
	heldOutTrajectories,
	makeOptimizeRequest,
	makeTrajectory,
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
	it("optimizes, gates, promotes, and can revert", async () => {
		const source = classifierSource();
		const region = classifierRegion(source);

		// 1. Offline training run: candidate must beat baseline on held-out data.
		const run = await runTrainingRun({
			request: makeOptimizeRequest({ generatedRegions: [region] }),
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
			regions: [region],
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

	it("runs the full Trace-style loop: capture with trainable(), optimize, gate, promote", async () => {
		const source = classifierSource();
		const region = classifierRegion(source);

		// Declare + forward: wrap the baseline; invocations become trajectories.
		const runtime = createCaptureRuntime();
		const classify = trainable((_input: string) => "identity-support", {
			runtime,
			run: { id: "run-live-1", tenantId: "tenant-a", traceparent: FIXTURE_TRACEPARENT },
			method: {
				name: "classify",
				contractRef: "contract://classify@1.0.0",
				generatedRegion: region,
				regionSource: source.slice(region.startOffset, region.endOffset),
			},
		});
		for (const ticket of ["billing invoice refund", "billing chargeback", "password reset"]) {
			classify(ticket);
		}
		expect(classify.trajectoryIds).toHaveLength(3);

		// Training evidence: label the captured shape via fixture trajectories
		// (live systems attach expectedLabel from evals/labels), then optimize
		// through the iterative loop against the wrapped region.
		const request: OptimizeRequest = {
			...makeOptimizeRequest({ generatedRegions: [region] }),
			schema: OPTIMIZE_REQUEST_SCHEMA,
			regionSources: { [region.regionId]: source.slice(region.startOffset, region.endOffset) },
			trajectories: [
				makeTrajectory({
					id: "labeled-1",
					input: "billing invoice refund",
					baselineLabel: "identity-support",
					expectedLabel: "billing-support",
					region,
				}),
				makeTrajectory({
					id: "labeled-2",
					input: "billing chargeback",
					baselineLabel: "identity-support",
					expectedLabel: "billing-support",
					region,
				}),
			],
		};
		const loop = await runOptimizationLoop({
			request,
			engine: createBuiltInOptoEngine(),
			heldOutTrajectories: heldOutTrajectories(),
		});
		expect(loop.outcome).toBe("ready-for-gate");
		const candidate = loop.finalRun.candidate;
		if (candidate === null) throw new Error("expected candidate");

		// Gate + promote.
		const decision = evaluatePromotionGate({
			candidateId: candidate.id,
			conformance: true,
			policy: true,
			evalResult: liveEval({ categoryCorrect: 0.96, piiSafe: 1 }),
			thresholds,
		});
		expect(decision.outcome).toBe("promote");

		const promoted = promoteCandidate({
			source,
			regions: [region],
			candidate,
			gate: { effect: "certify", certified: true },
			provenance: completeProvenance(),
			environment: "preview",
			riskClass: "low",
			ts: FIXTURE_TS,
		});
		expect(promoted.effect).toBe("auto-applied");
		expect(promoted.source).toContain('return "billing-support";');
	});

	it("a refused gate never reaches promotion", async () => {
		const run = await runTrainingRun({
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
