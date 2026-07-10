export interface StudentTurn<TFeedback> {
	readonly round: number;
	readonly feedback: readonly TFeedback[];
	readonly signal?: AbortSignal;
}

export interface TeacherResult<TAssessment, TFeedback> {
	readonly accepted: boolean;
	readonly assessment: TAssessment;
	readonly feedback: readonly TFeedback[];
}

export interface HarnessRound<TCandidate, TAssessment> {
	readonly round: number;
	readonly candidate: TCandidate;
	readonly assessment: TAssessment;
}

export interface HarnessRun<TCandidate, TAssessment> {
	readonly outcome: "accepted" | "stalled" | "exhausted";
	readonly rounds: readonly HarnessRound<TCandidate, TAssessment>[];
	readonly final: HarnessRound<TCandidate, TAssessment>;
}

export interface HarnessInput<TCandidate, TAssessment, TFeedback> {
	readonly student: (turn: StudentTurn<TFeedback>) => TCandidate | Promise<TCandidate>;
	readonly teacher: (
		candidate: TCandidate,
		turn: StudentTurn<TFeedback>,
	) => TeacherResult<TAssessment, TFeedback> | Promise<TeacherResult<TAssessment, TFeedback>>;
	readonly signal?: AbortSignal;
}

export interface HarnessSettings<TCandidate> {
	readonly maxRounds?: number;
	readonly candidateId: (candidate: TCandidate) => string;
}

export interface TrainingHarness<TCandidate, TAssessment, TFeedback> {
	run(input: HarnessInput<TCandidate, TAssessment, TFeedback>): Promise<HarnessRun<TCandidate, TAssessment>>;
}

export function defineTrainingHarness<TCandidate, TAssessment, TFeedback>(
	settings: HarnessSettings<TCandidate>,
): TrainingHarness<TCandidate, TAssessment, TFeedback> {
	const maxRounds = settings.maxRounds ?? 3;
	if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new TypeError("maxRounds must be a positive integer");

	return Object.freeze({
		async run(input: HarnessInput<TCandidate, TAssessment, TFeedback>) {
			const rounds: HarnessRound<TCandidate, TAssessment>[] = [];
			let feedback: readonly TFeedback[] = [];
			let previousCandidate: string | undefined;

			for (let round = 1; round <= maxRounds; round += 1) {
				input.signal?.throwIfAborted();
				const turn = Object.freeze({
					round,
					feedback,
					...(input.signal === undefined ? {} : { signal: input.signal }),
				});
				const candidate = await input.student(turn);
				input.signal?.throwIfAborted();
				const candidateId = settings.candidateId(candidate).trim();
				if (!candidateId) throw new TypeError("candidateId must return a non-empty string");
				if (candidateId === previousCandidate) return run("stalled", rounds);
				previousCandidate = candidateId;
				const result = await input.teacher(candidate, turn);
				const entry = Object.freeze({ round, candidate, assessment: result.assessment });
				rounds.push(entry);

				if (result.accepted) return run("accepted", rounds);
				feedback = Object.freeze([...result.feedback]);
			}

			return run("exhausted", rounds);
		},
	});
}

function run<TCandidate, TAssessment>(
	outcome: HarnessRun<TCandidate, TAssessment>["outcome"],
	rounds: HarnessRound<TCandidate, TAssessment>[],
): HarnessRun<TCandidate, TAssessment> {
	return Object.freeze({ outcome, rounds: Object.freeze([...rounds]), final: rounds.at(-1) as HarnessRound<TCandidate, TAssessment> });
}
