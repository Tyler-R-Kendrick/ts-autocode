import type { EvalRunResult } from "@agentv/core";

import type { BoundEvaluation, CandidatePatch } from "./engine.js";
import type { TrainableEvalRun } from "./evaluation.js";
import type { CandidateReview } from "./loop.js";
import { defined } from "./optional.js";
import type { PromotionDecision } from "./promotion.js";
import { defineTrainable, toTrainableToken, type TrainableIdentity } from "./token.js";

// Anyone implementing a custom TrainingLoop must return a CandidateReview
// containing a TrainableEvalRun, which only `evaluateTrainable` could produce.
// So the tests in this repo wrote `{ ... } as unknown as TrainableEvalRun` and
// `{} as never`, and a consumer had no better option. A type a consumer must
// supply but cannot construct is a hole in the contract; these fill it.

export interface EvalRunInput {
	readonly trainable: TrainableIdentity;
	readonly evaluations?: readonly BoundEvaluation[];
	/** The AgentV result, when there is a real one to carry. */
	readonly run?: EvalRunResult;
}

/** Builds a {@link TrainableEvalRun} — the shape a custom `TrainingLoop` must
 * return inside its reviews. */
export function createEvalRun(input: EvalRunInput): TrainableEvalRun {
	const token = toTrainableToken(input.trainable);
	return Object.freeze({
		token,
		run: input.run ?? emptyRun(),
		evaluations: Object.freeze([...(input.evaluations ?? [])]),
	});
}

export interface DecisionInput {
	readonly candidateId: string;
	readonly promote?: boolean;
	readonly failures?: readonly string[];
	readonly meanScore?: number;
	readonly passRate?: number;
}

/** Builds a {@link PromotionDecision}. `promote` defaults to whether there are
 * any failures, matching how the real gate decides. */
export function createPromotionDecision(input: DecisionInput): PromotionDecision {
	const failures = Object.freeze([...(input.failures ?? [])]);
	const promote = input.promote ?? failures.length === 0;
	return Object.freeze({
		candidateId: input.candidateId,
		promote,
		failures,
		meanScore: input.meanScore ?? (promote ? 1 : 0),
		passRate: input.passRate ?? (promote ? 1 : 0),
	});
}

export interface ReviewInput {
	readonly candidate: CandidatePatch;
	readonly promote?: boolean;
	readonly failures?: readonly string[];
	readonly evaluations?: readonly BoundEvaluation[];
	readonly verification?: TrainableEvalRun;
	readonly decision?: PromotionDecision;
}

/** Builds a {@link CandidateReview}, the value a `TrainingLoop` hands back for
 * each candidate it reviewed. */
export function createCandidateReview(input: ReviewInput): CandidateReview {
	return Object.freeze({
		verification: input.verification ?? createEvalRun({
			trainable: defineTrainable(input.candidate.trainableId),
			...defined({ evaluations: input.evaluations }),
		}),
		decision: input.decision ?? createPromotionDecision({
			candidateId: input.candidate.id,
			...defined({ promote: input.promote, failures: input.failures }),
		}),
	});
}

/** An AgentV run result with no cases, for reviews that carry their evidence in
 * `evaluations` rather than in a real eval run. Written out in full rather than
 * cast: the point of these builders is that nobody has to cast. */
function emptyRun(): EvalRunResult {
	return Object.freeze({
		results: [],
		summary: Object.freeze({
			total: 0,
			passed: 0,
			failed: 0,
			executionErrors: 0,
			durationMs: 0,
			meanScore: 0,
		}),
	});
}
