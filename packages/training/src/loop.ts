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
	/** 1-based fan-out slot within the round; always 1 without fan-out.
	 * Strategies can use it to diversify concurrent proposals. */
	readonly slot: number;
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
	/** Maximum number of candidates proposed and reviewed concurrently per
	 * round. Each slot runs its own propose→review pipeline; a slot whose
	 * proposal duplicates an already-reviewed candidate skips the review. */
	readonly fanOut?: number;
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

/** How many propose/review rounds a loop runs when `maxRounds` is unset. */
export const defaultMaxRounds = 3;

/** How many candidates a round explores concurrently when `fanOut` is unset. */
export const defaultFanOut = 1;

export interface RoundObserver {
	readonly next?: (round: TrainingRound) => void;
	readonly complete?: (outcome: TrainingLoopRun["outcome"]) => void;
	readonly error?: (error: unknown) => void;
}

/** A cold sequence of training rounds: every `subscribe` drives its own run,
 * pushing each reviewed round to the observer as it settles. When a round
 * promotes, the winning round is always the last one emitted before
 * `complete("ready")`. The returned function unsubscribes and aborts any
 * in-flight proposals and reviews. */
export interface RoundSequence {
	subscribe(observer: RoundObserver): () => void;
}

/** The observable propose/review sequence behind `sequentialLoop`. Rounds run
 * in order; within a round up to `fanOut` candidate pipelines run
 * concurrently. A round that reviews nothing new (every slot proposed an
 * already-seen candidate) completes the sequence as `"stalled"`. */
export function trainingRounds(input: TrainingLoopInput): RoundSequence {
	const maxRounds = input.maxRounds ?? defaultMaxRounds;
	if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new TypeError("maxRounds must be a positive integer");
	const fanOut = input.fanOut ?? defaultFanOut;
	if (!Number.isInteger(fanOut) || fanOut < 1) throw new TypeError("fanOut must be a positive integer");
	return {
		subscribe(observer) {
			let closed = false;
			const controller = new AbortController();
			const forwardAbort = () => controller.abort();
			if (input.signal?.aborted) forwardAbort();
			else input.signal?.addEventListener("abort", forwardAbort, { once: true });
			const settle = () => {
				closed = true;
				input.signal?.removeEventListener("abort", forwardAbort);
			};
			void drive({ ...input, maxRounds, fanOut }, controller.signal, {
				next: (round) => {
					if (!closed) observer.next?.(round);
				},
				complete: (outcome) => {
					if (closed) return;
					settle();
					observer.complete?.(outcome);
				},
				error: (error) => {
					if (closed) return;
					settle();
					observer.error?.(error);
				},
			});
			return () => {
				settle();
				controller.abort();
			};
		},
	};
}

/** Default loop: collects the observable round sequence into one run. */
export const sequentialLoop: TrainingLoop = (input) =>
	new Promise((resolve, reject) => {
		const rounds: TrainingRound[] = [];
		trainingRounds(input).subscribe({
			next: (round) => rounds.push(round),
			complete: (outcome) => resolve({ outcome, rounds }),
			error: reject,
		});
	});

async function drive(
	input: TrainingLoopInput & { readonly maxRounds: number; readonly fanOut: number },
	signal: AbortSignal,
	observer: Required<RoundObserver>,
): Promise<void> {
	const seen = new Set<string>();
	// One slot's pipeline: propose, skip duplicates of already-reviewed
	// candidates, review. Slots only await each other at the round boundary.
	const runSlot = async (round: number, slot: number, feedback: readonly string[]): Promise<TrainingRound | undefined> => {
		const candidate = await input.propose({ round, slot, feedback, signal });
		if (seen.has(candidate.id)) return undefined;
		seen.add(candidate.id);
		const label = input.fanOut === 1 ? `candidate-${round}` : `candidate-${round}-${slot}`;
		const review = await input.review(candidate, { label, signal });
		return Object.freeze({ round, candidate, ...review });
	};
	try {
		let feedback: readonly string[] = [];
		for (let round = 1; round <= input.maxRounds; round += 1) {
			signal.throwIfAborted();
			const reviewed = (await Promise.all(
				Array.from({ length: input.fanOut }, (_, index) => runSlot(round, index + 1, feedback)),
			)).filter((entry): entry is TrainingRound => entry !== undefined);
			if (reviewed.length === 0) return observer.complete("stalled");
			const winner = reviewed
				.filter((entry) => entry.decision.promote)
				.reduce<TrainingRound | undefined>(
					(best, entry) => (best === undefined || entry.decision.meanScore > best.decision.meanScore ? entry : best),
					undefined,
				);
			for (const entry of reviewed) {
				if (entry !== winner) observer.next(entry);
			}
			if (winner) {
				observer.next(winner);
				return observer.complete("ready");
			}
			feedback = [...new Set(reviewed.flatMap((entry) => entry.decision.failures))];
		}
		observer.complete("exhausted");
	} catch (error) {
		observer.error(error);
	}
}
