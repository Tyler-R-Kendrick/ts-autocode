import { resolve } from "node:path";

import {
	defineTrainingHarness,
	WriteAheadAgentBus,
	type ContextProvider,
	type JudgeDecision,
	type JudgeRequest,
} from "ts-autocode-harness";
import {
	LoopCapabilityError,
	optional,
	type CandidatePatch,
	type CandidateReview,
	type TrainingLoop,
	type TrainingLoopInput,
} from "ts-autocode-training";
import { createStorage, type Storage } from "unstorage";
import fsDriver from "unstorage/drivers/fs";

import { windowedContext } from "./context.js";

/** Where the default filesystem-driver storage mounts inside the run's
 * output directory. */
export const defaultActionLogDir = "harness-actions";

/** Every collaborator is injectable; the options only choose defaults. */
export interface HarnessLoopOptions {
	/** Builds the [unstorage](https://unstorage.unjs.io) instance backing a
	 * run's write-ahead bus — any driver (memory, fs, redis, http, ...).
	 * Unset, entries land on the local filesystem under
	 * `<outputDir>/harness-actions`. */
	readonly storage?: (input: TrainingLoopInput) => Storage;
	/** Context management for harness actors; a rolling window when unset. */
	readonly contextProvider?: ContextProvider;
	/** Gates every harness action and verdict. Unset, the harness's evidence
	 * convention decides — equivalent here, because training promotes a
	 * candidate exactly when its review reports no gate failures. */
	readonly judge?: (
		request: JudgeRequest<CandidatePatch, CandidateReview, string, CandidateReview>,
	) => JudgeDecision | Promise<JudgeDecision>;
}

/** Adapts the governed ts-autocode-harness loop to the provider-neutral
 * TrainingLoop contract. Training reviews serve as every role's evidence:
 * the teacher assesses the candidate, the adversary re-reviews an accepted
 * one, and the review's gate failures are the feedback the harness weighs. */
export function createHarnessLoop(options: HarnessLoopOptions = {}): TrainingLoop {
	const storage = options.storage ?? ((input: TrainingLoopInput) =>
		createStorage({ driver: fsDriver({ base: resolve(input.outputDir, defaultActionLogDir) }) }));
	const contextProvider = options.contextProvider ?? windowedContext();
	return async (input) => {
		// The governed harness explores exactly one candidate per round: its
		// judge -> adversary -> rubric-revision sequence is serial by
		// construction, and a standing challenge must tighten the rubric before
		// the next proposal. Rather than accept `fanOut` and quietly ignore it,
		// say so -- use `sequentialLoop`/`trainingRounds` for concurrent slots.
		if (input.fanOut !== undefined && input.fanOut > 1) {
			throw new LoopCapabilityError(
				`the governed harness loop reviews one candidate per round and cannot honor fanOut ${input.fanOut}; `
				+ "omit fanOut or set TrainingSettings.loop to sequentialLoop, which supports it",
			);
		}
		const harness = defineTrainingHarness<CandidatePatch, CandidateReview, string>(
			input.maxRounds === undefined ? {} : { maxRounds: input.maxRounds },
		);
		const result = await harness.run<CandidateReview>({
			bus: new WriteAheadAgentBus({ storage: storage(input) }),
			contextProvider,
			...(options.judge === undefined ? {} : { judge: options.judge }),
			task: { trainable: input.trainableId, objective: input.objective },
			rubric: input.rubric,
			...optional("signal", input.signal),
			student: ({ round, feedback, signal }) =>
				input.propose({ round, slot: 1, feedback, ...optional("signal", signal) }),
			teacher: async (candidate, { round, signal }) => {
				const review = await input.review(candidate, { label: `candidate-${round}`, ...optional("signal", signal) });
				return { assessment: review, feedback: review.decision.failures };
			},
			adversary: {
				challenge: async (candidate, { signal }) => {
					const challenge = await input.review(candidate, { label: `adversary-${candidate.id}`, ...optional("signal", signal) });
					return { challenge, feedback: challenge.decision.failures };
				},
			},
		});
		return {
			outcome: result.outcome === "accepted" ? "ready" : result.outcome,
			rounds: result.rounds.map(({ round, candidate, assessment }) => ({ round, candidate, ...assessment })),
		};
	};
}

