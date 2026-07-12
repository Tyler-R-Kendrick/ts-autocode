import { resolve } from "node:path";

import {
	defineTrainingHarness,
	FileBusStore,
	WriteAheadAgentBus,
	type ContextProvider,
	type JudgeDecision,
} from "ts-autocode-harness";
import type { CandidatePatch, CandidateReview, TrainingLoop, TrainingLoopInput } from "ts-autocode-training";

import { windowedContext } from "./context.js";

/** Where the default file-backed bus lands inside the run's output directory. */
export const defaultActionLogFile = "harness-actions.jsonl";

/** Every collaborator is injectable; the options only choose defaults. */
export interface HarnessLoopOptions {
	/** Builds the message bus for a run. Unset, each run gets a write-ahead bus
	 * over a JSONL `FileBusStore` in its output directory — swap in any
	 * `AgentBusStore`-backed bus (memory, remote, ...) here. */
	readonly bus?: (input: TrainingLoopInput) => WriteAheadAgentBus;
	/** File name for the default file-backed bus; ignored when `bus` is set. */
	readonly actionLogFile?: string;
	/** Context management for harness actors; a rolling window when unset. */
	readonly contextProvider?: ContextProvider;
	/** Gates every harness action and verdict. Unset, the harness's evidence
	 * convention decides — equivalent here, because training promotes a
	 * candidate exactly when its review reports no gate failures. */
	readonly judge?: (input: unknown) => JudgeDecision | Promise<JudgeDecision>;
}

/** Adapts the governed ts-autocode-harness loop to the provider-neutral
 * TrainingLoop contract. Training reviews serve as every role's evidence:
 * the teacher assesses the candidate, the adversary re-reviews an accepted
 * one, and the review's gate failures are the feedback the harness weighs. */
export function createHarnessLoop(options: HarnessLoopOptions = {}): TrainingLoop {
	const createBus = options.bus ?? ((input: TrainingLoopInput) =>
		new WriteAheadAgentBus({ store: new FileBusStore(resolve(input.outputDir, options.actionLogFile ?? defaultActionLogFile)) }));
	const contextProvider = options.contextProvider ?? windowedContext();
	return async (input) => {
		const harness = defineTrainingHarness<CandidatePatch, CandidateReview, string>(
			input.maxRounds === undefined ? {} : { maxRounds: input.maxRounds },
		);
		const result = await harness.run<CandidateReview>({
			bus: createBus(input),
			contextProvider,
			...(options.judge === undefined ? {} : { judge: options.judge }),
			task: { trainable: input.trainableId, objective: input.objective },
			rubric: input.rubric,
			...(input.signal === undefined ? {} : { signal: input.signal }),
			// The governed harness explores one candidate per round; fan-out stays 1.
			student: ({ round, feedback, signal }) =>
				input.propose({ round, slot: 1, feedback, ...(signal === undefined ? {} : { signal }) }),
			teacher: async (candidate, { round, signal }) => {
				const review = await input.review(candidate, {
					label: `candidate-${round}`,
					...(signal === undefined ? {} : { signal }),
				});
				return { assessment: review, feedback: review.decision.failures };
			},
			adversary: async (candidate, { signal }) => {
				const challenge = await input.review(candidate, {
					label: `adversary-${candidate.id}`,
					...(signal === undefined ? {} : { signal }),
				});
				return { challenge, feedback: challenge.decision.failures };
			},
		});
		return {
			outcome: result.outcome === "accepted" ? "ready" : result.outcome,
			rounds: result.rounds.map(({ round, candidate, assessment }) => ({ round, candidate, ...assessment })),
		};
	};
}
