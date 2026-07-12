import { resolve } from "node:path";

import {
	defineTrainingHarness,
	FileBusStore,
	WriteAheadAgentBus,
	type ContextProvider,
	type JudgeRequest,
} from "ts-autocode-harness";
import type { CandidatePatch, CandidateReview, TrainingLoop } from "ts-autocode-training";

import { windowedContext } from "./context.js";

type Request = JudgeRequest<CandidatePatch, CandidateReview, CandidateReview>;

/** Where the write-ahead action log lands inside the run's output directory
 * when `createHarnessLoop` is not given a filename. */
export const defaultActionLogFile = "harness-actions.jsonl";

export interface HarnessLoopOptions {
	readonly actionLogFile?: string;
	/** Context management for harness actors; a rolling window when unset. */
	readonly contextProvider?: ContextProvider;
}

/** Adapts the governed ts-autocode-harness loop to the provider-neutral
 * TrainingLoop contract: a write-ahead action bus, an exact pass/fail judge on
 * the promotion decision, adversarial re-verification of accepted candidates,
 * and rubric revision when a challenge exposes a gap. */
export function createHarnessLoop(options: HarnessLoopOptions = {}): TrainingLoop {
	const actionLogFile = options.actionLogFile ?? defaultActionLogFile;
	const contextProvider = options.contextProvider ?? windowedContext();
	return async (input) => {
		const harness = defineTrainingHarness<CandidatePatch, CandidateReview, string>({
			candidateId: (candidate) => candidate.id,
			...(input.maxRounds === undefined ? {} : { maxRounds: input.maxRounds }),
		});
		const bus = new WriteAheadAgentBus({ store: new FileBusStore(resolve(input.outputDir, actionLogFile)) });
		const result = await harness.run<CandidateReview>({
			bus,
			contextProvider,
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
			judge: (request) => {
				const typed = request as Request;
				if (typed.subject === "action") return "pass";
				if (typed.subject === "candidate") return typed.assessment.decision.promote ? "pass" : "fail";
				// The adversary re-verified an accepted candidate; a failed gate means
				// the challenge stands and the rubric must be revised.
				return typed.challenge.decision.promote ? "fail" : "pass";
			},
			adversary: (candidate, { signal }) =>
				input.review(candidate, {
					label: `adversary-${candidate.id}`,
					...(signal === undefined ? {} : { signal }),
				}),
			reviseRubric: (challenge, { rubric }) => ({
				rubric: `${rubric}\nAdversarial criteria: ${challenge.decision.failures.join("; ")}`,
				feedback: challenge.decision.failures,
			}),
		});
		return {
			outcome: result.outcome === "accepted" ? "ready" : result.outcome,
			rounds: result.rounds.map(({ round, candidate, assessment }) => ({ round, candidate, ...assessment })),
		};
	};
}
