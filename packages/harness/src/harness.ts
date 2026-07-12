import { WriteAheadAgentBus } from "./bus.js";
import { dispatchAction, recordDecision, type ActionGate, type JudgeDecision } from "./dispatch.js";
import { candidateKey, roundLimit, rubricText, type AgentBusEntry } from "./schema.js";

// The run's actors — named for the HarnessInput callbacks they run — and the
// message kinds they write, spelled once here. Bus entries are serialized to
// storage, so both must stay plain strings rather than symbols.
const actors = { student: "student", teacher: "teacher", adversary: "adversary" } as const;
const kinds = {
	propose: "agent.propose",
	assess: "agent.assess",
	challenge: "agent.challenge",
	reviseRubric: "agent.revise-rubric",
} as const;

/** Shapes the bus history handed to actors and the judge. The bus itself does
 * no context management: windowing, rolling summaries, or any other
 * optimization belong to the consumer's provider (in the spirit of Semantic
 * Kernel's chat-history reducers). The full history is passed when unset. */
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

/** What the adversary reports back: the challenge artifact plus the evidence
 * it gathered against the candidate. Mirrors `TeacherResult`, and the feedback
 * is what the default judge weighs — a challenge without evidence fails. */
export interface AdversaryResult<TChallenge, TFeedback> {
	readonly challenge: TChallenge;
	readonly feedback: readonly TFeedback[];
}

export interface RubricRevision<TFeedback> {
	readonly rubric: string;
	readonly feedback: readonly TFeedback[];
}

/** The challenge turn is deliberately narrow: the adversary sees the task and
 * only its own prior messages, never the teacher's assessment or the rubric. */
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

/** The adversary role in full. Challenging accepted candidates and tightening
 * the rubric when a challenge stands are one responsibility, so both callbacks
 * live here; only the challenge is required. */
export interface AdversaryConfig<TCandidate, TAssessment, TFeedback, TChallenge> {
	/** Challenges a candidate the judge accepted. */
	readonly challenge: (
		candidate: TCandidate,
		turn: AdversaryTurn,
	) => AdversaryResult<TChallenge, TFeedback> | Promise<AdversaryResult<TChallenge, TFeedback>>;
	/** Revises the rubric after a standing challenge; when unset the challenge
	 * evidence is appended to the rubric as new criteria. */
	readonly reviseRubric?: (
		challenge: AdversaryResult<TChallenge, TFeedback>,
		turn: RubricRevisionTurn<TCandidate, TAssessment>,
	) => RubricRevision<TFeedback> | Promise<RubricRevision<TFeedback>>;
}

/** Every request carries the evidence the default verdicts weigh, so a
 * configured judge can apply the same convention even when its bus context is
 * windowed or redacted. */
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
	/** The run's message bus — the full audit log, even when defaulted. */
	readonly bus: WriteAheadAgentBus;
}

/** A run needs only a student and a teacher; every other role has a default.
 * The defaults follow one evidence convention: feedback is the verdict. A
 * candidate passes when the teacher reports no feedback, and an adversarial
 * challenge stands when the adversary reports evidence against the candidate. */
export interface HarnessInput<TCandidate, TAssessment, TFeedback, TChallenge> {
	readonly task: unknown;
	readonly rubric: string;
	readonly student: (turn: StudentTurn<TFeedback>) => TCandidate | Promise<TCandidate>;
	readonly teacher: (
		candidate: TCandidate,
		turn: StudentTurn<TFeedback>,
	) => TeacherResult<TAssessment, TFeedback> | Promise<TeacherResult<TAssessment, TFeedback>>;
	/** Message log for the run; an in-memory write-ahead bus when unset. */
	readonly bus?: WriteAheadAgentBus;
	/** Gates every action and verdict. When unset, actions are logged ungated
	 * and verdicts follow the evidence convention above. */
	readonly judge?: (
		request: JudgeRequest<TCandidate, TAssessment, TFeedback, TChallenge>,
	) => JudgeDecision | Promise<JudgeDecision>;
	/** Challenges candidates the judge accepted, and optionally revises the
	 * rubric when a challenge stands. When unset, a passing candidate is
	 * accepted without adversarial review. */
	readonly adversary?: AdversaryConfig<TCandidate, TAssessment, TFeedback, TChallenge>;
	/** Shapes bus history into actor context; full history when unset. */
	readonly contextProvider?: ContextProvider;
	readonly signal?: AbortSignal;
}

export interface HarnessSettings<TCandidate> {
	readonly maxRounds?: number;
	/** Candidate identity for stall detection; the candidate's own string form
	 * when unset, so identical proposals stall without configuration. */
	readonly candidateId?: (candidate: TCandidate) => string;
}

/** How many student rounds a harness runs when `maxRounds` is unset. */
export const defaultMaxRounds = 3;

export interface TrainingHarness<TCandidate, TAssessment, TFeedback> {
	run<TChallenge>(input: HarnessInput<TCandidate, TAssessment, TFeedback, TChallenge>): Promise<HarnessRun<TCandidate, TAssessment, TChallenge>>;
}

export function defineTrainingHarness<TCandidate, TAssessment, TFeedback>(
	settings: HarnessSettings<TCandidate> = {},
): TrainingHarness<TCandidate, TAssessment, TFeedback> {
	const maxRounds = roundLimit.parse(settings.maxRounds ?? defaultMaxRounds);
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

			// Factories for the shapes every turn rebuilds: the optional abort
			// signal and provider-shaped context.
			const signal = input.signal === undefined ? {} : { signal: input.signal };
			const contextOf = async (actor?: string) => provide(await bus.read(actor));

			// Every actor invocation is written ahead; a configured judge also
			// gates it, and every verdict — the judge's or the evidence
			// convention's — lands on the bus as an ordinary judge message.
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
				// The evidence both verdict requests carry, and one factory for
				// every shape a recorded round takes.
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

/** Default candidate identity: the candidate's own string form, so identical
 * proposals are detected as a stall without configuration. */
function stringifyCandidate(candidate: unknown): string {
	return typeof candidate === "string" ? candidate : JSON.stringify(candidate) ?? String(candidate);
}

/** Default rubric revision: a standing challenge's evidence becomes new
 * criteria, so the rubric always tightens and the loop cannot re-accept the
 * same gap. */
function appendCriteria<TChallenge, TFeedback>(
	challenge: AdversaryResult<TChallenge, TFeedback>,
	turn: Readonly<{ rubric: string }>,
): RubricRevision<TFeedback> {
	const criteria = challenge.feedback
		.map((item) => typeof item === "string" ? item : JSON.stringify(item))
		.join("; ");
	return { rubric: `${turn.rubric}\nAdversarial criteria: ${criteria}`, feedback: challenge.feedback };
}
