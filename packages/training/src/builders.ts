import type { EvalRunResult } from "@agentv/core";

import type { BoundEvaluation, CandidatePatch } from "./engine.js";
import type { TrainableEvalRun } from "./evaluation.js";
import type { CandidateReview } from "./loop.js";
import { defined } from "./optional.js";
import type { PromotionDecision } from "./promotion.js";
import { defineTrainable, toTrainableToken, type TrainableIdentity } from "./token.js";


export interface EvalRunInput {
	readonly trainable: TrainableIdentity;
	readonly evaluations?: readonly BoundEvaluation[];
	readonly run?: EvalRunResult;
}

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
