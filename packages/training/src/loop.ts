import type { CandidatePatch } from "./engine.js";
import { parseSetting, positiveIntegerSetting } from "./errors.js";
import type { TrainableEvalRun } from "./evaluation.js";
import type { PromotionDecision } from "./promotion.js";
import type { TrainableId } from "./token.js";

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
	readonly slot: number;
	readonly feedback: readonly string[];
	readonly signal?: AbortSignal;
}

export interface ReviewContext {
	readonly label: string;
	readonly signal?: AbortSignal;
}

export interface TrainingLoopInput {
	readonly trainableId: TrainableId;
	readonly objective: string;
	readonly rubric: string;
	readonly outputDir: string;
	readonly maxRounds?: number;
	readonly fanOut?: number;
	readonly signal?: AbortSignal;
	readonly propose: (turn: ProposalTurn) => Promise<CandidatePatch>;
	readonly review: (candidate: CandidatePatch, context: ReviewContext) => Promise<CandidateReview>;
}

export interface TrainingLoopRun {
	readonly outcome: "ready" | "stalled" | "exhausted";
	readonly rounds: readonly TrainingRound[];
}

export type TrainingLoop = (input: TrainingLoopInput) => Promise<TrainingLoopRun>;

export const defaultMaxRounds = 3;

export const defaultFanOut = 1;

export interface RoundObserver {
	readonly next?: (round: TrainingRound) => void;
	readonly complete?: (outcome: TrainingLoopRun["outcome"]) => void;
	readonly error?: (error: unknown) => void;
}

export interface RoundSequence {
	subscribe(observer: RoundObserver): () => void;
}

const roundLimit = positiveIntegerSetting("maxRounds must be a positive integer");
const fanOutWidth = positiveIntegerSetting("fanOut must be a positive integer");

export function trainingRounds(input: TrainingLoopInput): RoundSequence {
	const maxRounds = parseSetting(roundLimit, input.maxRounds ?? defaultMaxRounds);
	const fanOut = parseSetting(fanOutWidth, input.fanOut ?? defaultFanOut);
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
			const guarded = (deliver: () => void) => {
				try {
					deliver();
				} catch {
				}
			};
			void drive({ ...input, maxRounds, fanOut }, controller.signal, {
				next: (round) => {
					if (!closed) guarded(() => observer.next?.(round));
				},
				complete: (outcome) => {
					if (closed) return;
					settle();
					guarded(() => observer.complete?.(outcome));
				},
				error: (error) => {
					if (closed) return;
					settle();
					guarded(() => observer.error?.(error));
				},
			});
			return () => {
				settle();
				controller.abort();
			};
		},
	};
}

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
