import type { OptimizeRequest, TrainingEngine } from "./engine.js";
import { type TrainingRunResult, runBuiltInOptoTrainingRun } from "./optimizer.js";
import type { Feedback, Trajectory } from "./trajectory.js";

// The Trace-style epoch loop (zero_feedback → backward → step), bounded:
// each round proposes and screens a candidate; a rejection round's reasons
// become general feedback on the next request, so a feedback-aware engine
// can repair its own candidate. Deterministic engines that ignore feedback
// stall and the loop stops early instead of burning rounds.

export interface OptimizationRound {
	readonly round: number;
	readonly run: TrainingRunResult;
	/** Feedback appended to the request after this round (empty on success). */
	readonly feedback: readonly Feedback[];
}

export interface OptimizationLoopResult {
	readonly outcome: "ready-for-gate" | "stalled" | "exhausted";
	readonly rounds: readonly OptimizationRound[];
	/** The last round's run — the candidate to gate when outcome is ready-for-gate. */
	readonly finalRun: TrainingRunResult;
}

export interface OptimizationLoopInput {
	readonly request: OptimizeRequest;
	readonly engine: TrainingEngine;
	readonly heldOutTrajectories: readonly Trajectory[];
	/** Maximum propose→screen rounds (default 3). */
	readonly maxRounds?: number;
	/** Observer invoked after each round. */
	readonly onRound?: (round: OptimizationRound) => void;
}

/**
 * Iteratively optimize until the candidate is ready for the promotion gate,
 * the engine stalls (same candidate twice in a row), or rounds run out.
 * The caller's request is never mutated; each round gets a fresh clone with
 * the accumulated feedback attached.
 */
export async function runOptimizationLoop({
	request,
	engine,
	heldOutTrajectories,
	maxRounds = 3,
	onRound,
}: OptimizationLoopInput): Promise<OptimizationLoopResult> {
	if (!Number.isInteger(maxRounds) || maxRounds < 1) {
		throw new TypeError("maxRounds must be a positive integer");
	}

	const rounds: OptimizationRound[] = [];
	const accumulated: Feedback[] = [...(request.feedback ?? [])];
	let previousCandidateId: string | null = null;

	for (let round = 1; round <= maxRounds; round += 1) {
		const roundRequest: OptimizeRequest = {
			...structuredClone(request),
			feedback: structuredClone(accumulated),
		};
		const run = await runBuiltInOptoTrainingRun({
			request: roundRequest,
			heldOutTrajectories,
			engine,
		});

		if (run.outcome === "ready-for-gate") {
			const entry: OptimizationRound = { round, run, feedback: [] };
			rounds.push(entry);
			onRound?.(entry);
			return { outcome: "ready-for-gate", rounds, finalRun: run };
		}

		const feedback: Feedback[] = run.rejectionReasons.map((reason) => ({
			kind: "error",
			message: reason,
		}));
		const entry: OptimizationRound = { round, run, feedback };
		rounds.push(entry);
		onRound?.(entry);
		accumulated.push(...feedback);

		const candidateId = run.candidate?.id ?? null;
		if (candidateId !== null && candidateId === previousCandidateId) {
			return { outcome: "stalled", rounds, finalRun: run };
		}
		previousCandidateId = candidateId;
	}

	return { outcome: "exhausted", rounds, finalRun: (rounds.at(-1) as OptimizationRound).run };
}
