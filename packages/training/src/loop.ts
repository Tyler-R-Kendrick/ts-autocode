import type { CandidatePatch } from "./engine.js";
import type { TrainableEvalRun } from "./evaluation.js";
import type { PromotionDecision } from "./promotion.js";
import type { TrainableId } from "./token.js";

/** A proposed candidate verified with candidate-bound evals and gated for promotion. */
export interface CandidateReview {
	readonly verification: TrainableEvalRun;
	readonly decision: PromotionDecision;
}

export interface TrainingRound extends CandidateReview {
	readonly round: number;
	readonly candidate: CandidatePatch;
}

export interface ProposalTurn {
	readonly round: number;
	/** Failure feedback from earlier reviews of rejected candidates. */
	readonly feedback: readonly string[];
	readonly signal?: AbortSignal;
}

export interface ReviewContext {
	/** Unique per review; names the eval output subdirectory. */
	readonly label: string;
	readonly signal?: AbortSignal;
}

/** One bounded training run handed to a TrainingLoop. The loop owns iteration
 * and stopping; proposing and reviewing candidates stay with the runtime. */
export interface TrainingLoopInput {
	readonly trainableId: TrainableId;
	readonly objective: string;
	/** Human-readable promotion criteria for loops with judging agents. */
	readonly rubric: string;
	/** Directory for loop artifacts and per-review eval output. */
	readonly outputDir: string;
	readonly maxRounds?: number;
	readonly signal?: AbortSignal;
	readonly propose: (turn: ProposalTurn) => Promise<CandidatePatch>;
	readonly review: (candidate: CandidatePatch, context: ReviewContext) => Promise<CandidateReview>;
}

export interface TrainingLoopRun {
	readonly outcome: "ready" | "stalled" | "exhausted";
	readonly rounds: readonly TrainingRound[];
}

/** Orchestrates propose/review rounds. The built-in sequential loop is the
 * default; providers can substitute richer orchestration (ts-autocode wires
 * the governed ts-autocode-harness loop) without this package depending on it. */
export type TrainingLoop = (input: TrainingLoopInput) => Promise<TrainingLoopRun>;

/** Default loop: propose, review, stop on promotion, feed failures back. */
export const sequentialLoop: TrainingLoop = async (input) => {
	const maxRounds = input.maxRounds ?? 3;
	if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new TypeError("maxRounds must be a positive integer");
	const signal = input.signal === undefined ? {} : { signal: input.signal };
	const rounds: TrainingRound[] = [];
	let feedback: readonly string[] = [];
	let previousId: string | undefined;
	for (let round = 1; round <= maxRounds; round += 1) {
		input.signal?.throwIfAborted();
		const candidate = await input.propose({ round, feedback, ...signal });
		if (candidate.id === previousId) return { outcome: "stalled", rounds };
		previousId = candidate.id;
		const review = await input.review(candidate, { label: `candidate-${round}`, ...signal });
		rounds.push(Object.freeze({ round, candidate, ...review }));
		if (review.decision.promote) return { outcome: "ready", rounds };
		feedback = review.decision.failures;
	}
	return { outcome: "exhausted", rounds };
};
