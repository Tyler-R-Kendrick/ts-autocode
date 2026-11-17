import { WriteAheadAgentBus } from "./bus.js";
import { dispatchAction, recordDecision, type ActionGate, type JudgeDecision } from "./dispatch.js";
import { candidateKey, roundLimit, rubricText, type AgentBusEntry } from "./schema.js";

const actors = { student: "student", teacher: "teacher", adversary: "adversary" } as const;
const kinds = {
	propose: "agent.propose",
	assess: "agent.assess",
	challenge: "agent.challenge",
	reviseRubric: "agent.revise-rubric",
} as const;

export type ContextProvider = (
	entries: readonly AgentBusEntry[],
) => readonly AgentBusEntry[] | Promise<readonly AgentBusEntry[]>;

export interface StudentTurn<TFeedback> {
	readonly round: number;
	readonly task: unknown;
	readonly rubric: string;
	readonly feedback: readonly TFeedback[];
	readonly context: readonly AgentBusEntry[];
	readonly signal?: AbortSignal;
}

export interface TeacherResult<TAssessment, TFeedback> {
	readonly assessment: TAssessment;
	readonly feedback: readonly TFeedback[];
}

export interface AdversaryResult<TChallenge, TFeedback> {
	readonly challenge: TChallenge;
	readonly feedback: readonly TFeedback[];
}

export interface RubricRevision<TFeedback> {
	readonly rubric: string;
	readonly feedback: readonly TFeedback[];
}

export interface AdversaryTurn {
	readonly task: unknown;
	readonly context: readonly AgentBusEntry[];
	readonly signal?: AbortSignal;
}

export interface RubricRevisionTurn<TCandidate, TAssessment> {
	readonly task: unknown;
	readonly candidate: TCandidate;
	readonly assessment: TAssessment;
	readonly rubric: string;
	readonly context: readonly AgentBusEntry[];
	readonly signal?: AbortSignal;
}

export interface AdversaryConfig<TCandidate, TAssessment, TFeedback, TChallenge> {
	readonly challenge: (
		candidate: TCandidate,
		turn: AdversaryTurn,
	) => AdversaryResult<TChallenge, TFeedback> | Promise<AdversaryResult<TChallenge, TFeedback>>;
	readonly reviseRubric?: (
		challenge: AdversaryResult<TChallenge, TFeedback>,
		turn: RubricRevisionTurn<TCandidate, TAssessment>,
	) => RubricRevision<TFeedback> | Promise<RubricRevision<TFeedback>>;
}

export type JudgeRequest<TCandidate, TAssessment, TFeedback, TChallenge> =
	| Readonly<{ subject: "action"; action: AgentBusEntry; context: readonly AgentBusEntry[] }>
	| Readonly<{ subject: "candidate"; task: unknown; candidate: TCandidate; assessment: TAssessment; feedback: readonly TFeedback[]; rubric: string; context: readonly AgentBusEntry[] }>
	| Readonly<{ subject: "adversary"; task: unknown; candidate: TCandidate; challenge: TChallenge; feedback: readonly TFeedback[]; rubric: string; context: readonly AgentBusEntry[] }>;

export interface HarnessRound<TCandidate, TAssessment, TChallenge> {
	readonly round: number;
	readonly candidate: TCandidate;
	readonly assessment: TAssessment;
	readonly judgeDecision: JudgeDecision;
	readonly adversary?: Readonly<{ challenge: TChallenge; decision: JudgeDecision }>;
	readonly rubric: string;
}

export interface HarnessRun<TCandidate, TAssessment, TChallenge> {
	readonly outcome: "accepted" | "stalled" | "exhausted";
	readonly rounds: readonly HarnessRound<TCandidate, TAssessment, TChallenge>[];
	readonly final: HarnessRound<TCandidate, TAssessment, TChallenge>;
	readonly rubric: string;
	readonly bus: WriteAheadAgentBus;
}

export interface HarnessInput<TCandidate, TAssessment, TFeedback, TChallenge> {
	readonly task: unknown;
	readonly rubric: string;
	readonly student: (turn: StudentTurn<TFeedback>) => TCandidate | Promise<TCandidate>;
	readonly teacher: (
		candidate: TCandidate,
		turn: StudentTurn<TFeedback>,
	) => TeacherResult<TAssessment, TFeedback> | Promise<TeacherResult<TAssessment, TFeedback>>;
	readonly bus?: WriteAheadAgentBus;
	readonly judge?: (
		request: JudgeRequest<TCandidate, TAssessment, TFeedback, TChallenge>,
	) => JudgeDecision | Promise<JudgeDecision>;
	readonly adversary?: AdversaryConfig<TCandidate, TAssessment, TFeedback, TChallenge>;
	readonly contextProvider?: ContextProvider;
	readonly signal?: AbortSignal;
}

export interface HarnessSettings<TCandidate> {
	readonly maxRounds?: number;
	readonly candidateId?: (candidate: TCandidate) => string;
}

export const defaultHarnessRounds = 3;

/** @deprecated Renamed to {@link defaultHarnessRounds}; the old name collided
 * with `ts-autocode-training`'s loop default, which kept both out of the root
 * package's exports. */
export const defaultMaxRounds = defaultHarnessRounds;

export interface TrainingHarness<TCandidate, TAssessment, TFeedback> {
	run<TChallenge>(input: HarnessInput<TCandidate, TAssessment, TFeedback, TChallenge>): Promise<HarnessRun<TCandidate, TAssessment, TChallenge>>;
}

export interface InferringTrainingHarness<TCandidate> {
	run<TAssessment, TFeedback, TChallenge>(
		input: HarnessInput<TCandidate, TAssessment, TFeedback, TChallenge>,
	): Promise<HarnessRun<TCandidate, TAssessment, TChallenge>>;
}

export function inferringHarness<TCandidate = unknown>(
	settings: HarnessSettings<TCandidate> = {},
): InferringTrainingHarness<TCandidate> {
	return defineTrainingHarness<TCandidate, never, never>(settings) as unknown as InferringTrainingHarness<TCandidate>;
}

export function defineTrainingHarness<TCandidate, TAssessment, TFeedback>(
	settings: HarnessSettings<TCandidate> = {},
): TrainingHarness<TCandidate, TAssessment, TFeedback> {
	const maxRounds = roundLimit.parse(settings.maxRounds ?? defaultHarnessRounds);
	const identify = settings.candidateId ?? stringifyCandidate;

	return Object.freeze({
		async run<TChallenge>(input: HarnessInput<TCandidate, TAssessment, TFeedback, TChallenge>) {
			const bus = input.bus ?? new WriteAheadAgentBus();
			const provide = input.contextProvider ?? fullHistory;
			const judge = input.judge;
			let rubric: string = rubricText.parse(input.rubric);
			const rounds: HarnessRound<TCandidate, TAssessment, TChallenge>[] = [];
			let feedback: readonly TFeedback[] = [];
			let previousCandidate: string | undefined;

			const signal = input.signal === undefined ? {} : { signal: input.signal };
			const contextOf = async (actor?: string) => provide(await bus.read(actor));

			const gate: ActionGate | undefined = judge === undefined ? undefined : async (action, context) =>
				judge(Object.freeze({ subject: "action", action, context: await provide(context) }));
			const dispatch = <T>(actor: string, kind: string, payload: unknown, execute: () => Promise<T> | T) =>
				dispatchAction(bus, actor, kind, payload, gate, execute);
			const decide = async (
				payload: Readonly<Record<string, unknown>>,
				request: JudgeRequest<TCandidate, TAssessment, TFeedback, TChallenge>,
				fallback: () => JudgeDecision,
			): Promise<JudgeDecision> => {
				const decision = judge === undefined
					? fallback()
					: await judge(Object.freeze({ ...request, context: await provide(await bus.read()) }));
				await recordDecision(bus, { subject: request.subject, ...payload, decision });
				return decision;
			};
			const result = (outcome: HarnessRun<TCandidate, TAssessment, TChallenge>["outcome"]) =>
				Object.freeze({ outcome, rounds: Object.freeze([...rounds]),
					final: rounds.at(-1) as HarnessRound<TCandidate, TAssessment, TChallenge>, rubric, bus });

			for (let round = 1; round <= maxRounds; round += 1) {
				input.signal?.throwIfAborted();
				const turn: StudentTurn<TFeedback> = Object.freeze({
					round, task: input.task, rubric, feedback, context: await contextOf(), ...signal,
				});
				const candidate = await dispatch(actors.student, kinds.propose, { round, task: input.task, rubric, feedback },
					() => input.student(turn));
				input.signal?.throwIfAborted();
				const candidateId: string = candidateKey.parse(identify(candidate));
				if (candidateId === previousCandidate) return result("stalled");
				previousCandidate = candidateId;

				const assessment = await dispatch(actors.teacher, kinds.assess, { round, candidateId },
					() => input.teacher(candidate, turn));
				input.signal?.throwIfAborted();
				const evidence = { task: input.task, candidate, rubric, context: [] } as const;
				const candidateDecision = await decide({ candidateId },
					{ subject: "candidate", ...evidence, assessment: assessment.assessment, feedback: assessment.feedback },
					() => assessment.feedback.length === 0 ? "pass" : "fail");
				const record = (challenged?: Readonly<{ challenge: TChallenge; decision: JudgeDecision }>) =>
					rounds.push(Object.freeze({
						round, candidate, assessment: assessment.assessment, judgeDecision: candidateDecision,
						...(challenged === undefined ? {} : { adversary: Object.freeze(challenged) }), rubric,
					}));

				if (candidateDecision === "fail") {
					record();
					feedback = Object.freeze([...assessment.feedback]);
					continue;
				}

				const adversary = input.adversary;
				if (adversary === undefined) {
					record();
					return result("accepted");
				}

				const challenge = await dispatch(actors.adversary, kinds.challenge, { candidateId }, async () =>
					adversary.challenge(candidate, { task: input.task, context: await contextOf(actors.adversary), ...signal }));
				input.signal?.throwIfAborted();
				const challengeDecision = await decide({ candidateId },
					{ subject: "adversary", ...evidence, challenge: challenge.challenge, feedback: challenge.feedback },
					() => challenge.feedback.length > 0 ? "pass" : "fail");

				if (challengeDecision === "fail") {
					record({ challenge: challenge.challenge, decision: challengeDecision });
					return result("accepted");
				}

				const revise = adversary.reviseRubric ?? appendCriteria;
				const revision = await dispatch(actors.adversary, kinds.reviseRubric, { round, candidateId }, async () =>
					revise(challenge, {
						task: input.task, candidate, assessment: assessment.assessment, rubric,
						context: await contextOf(), ...signal,
					}));
				input.signal?.throwIfAborted();
				const revised: string = rubricText.parse(revision.rubric);
				if (revised === rubric) throw new Error("adversary must improve the rubric after a standing challenge");
				rubric = revised;
				feedback = Object.freeze([...revision.feedback]);
				record({ challenge: challenge.challenge, decision: challengeDecision });
			}

			return result("exhausted");
		},
	});
}

const fullHistory: ContextProvider = (entries) => entries;

function stringifyCandidate(candidate: unknown): string {
	return typeof candidate === "string" ? candidate : JSON.stringify(candidate) ?? String(candidate);
}

function appendCriteria<TChallenge, TFeedback>(
	challenge: AdversaryResult<TChallenge, TFeedback>,
	turn: Readonly<{ rubric: string }>,
): RubricRevision<TFeedback> {
	const criteria = challenge.feedback
		.map((item) => typeof item === "string" ? item : JSON.stringify(item))
		.join("; ");
	return { rubric: `${turn.rubric}\nAdversarial criteria: ${criteria}`, feedback: challenge.feedback };
}
