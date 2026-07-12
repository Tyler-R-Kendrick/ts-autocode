import { type AgentBusEntry, type WriteAheadAgentBus } from "./bus.js";
import { dispatchAction, decisionKind, requireDecision, type ActionGate, type JudgeDecision } from "./dispatch.js";

export { defaultContextEntries, WriteAheadAgentBus } from "./bus.js";
export type { AgentBusAccess, AgentBusEntry, AgentBusSettings, AgentMessage } from "./bus.js";
export { AgentActionDeniedError, decisionKind, dispatchAction } from "./dispatch.js";
export type { ActionGate, JudgeDecision } from "./dispatch.js";
export { createHarnessPolicy, sandboxPolicyVersion } from "./policy.js";
export type { HarnessPolicySettings } from "./policy.js";
export { MxcSandbox } from "./sandbox.js";
export type { MxcSandboxSettings } from "./sandbox.js";

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

export interface RubricRevision<TFeedback> {
	readonly rubric: string;
	readonly feedback: readonly TFeedback[];
}

export type JudgeRequest<TCandidate, TAssessment, TChallenge> =
	| Readonly<{ subject: "action"; action: AgentBusEntry; context: readonly AgentBusEntry[] }>
	| Readonly<{ subject: "candidate"; task: unknown; candidate: TCandidate; assessment: TAssessment; rubric: string; context: readonly AgentBusEntry[] }>
	| Readonly<{ subject: "adversary"; task: unknown; candidate: TCandidate; challenge: TChallenge; rubric: string; context: readonly AgentBusEntry[] }>;

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
}

export interface HarnessInput<TCandidate, TAssessment, TFeedback, TChallenge> {
	readonly bus: WriteAheadAgentBus;
	readonly task: unknown;
	readonly rubric: string;
	readonly student: (turn: StudentTurn<TFeedback>) => TCandidate | Promise<TCandidate>;
	readonly teacher: (
		candidate: TCandidate,
		turn: StudentTurn<TFeedback>,
	) => TeacherResult<TAssessment, TFeedback> | Promise<TeacherResult<TAssessment, TFeedback>>;
	readonly judge: (input: unknown) => JudgeDecision | Promise<JudgeDecision>;
	readonly adversary: (
		candidate: TCandidate,
		turn: Readonly<{ task: unknown; context: readonly AgentBusEntry[]; signal?: AbortSignal }>,
	) => TChallenge | Promise<TChallenge>;
	readonly reviseRubric: (
		challenge: TChallenge,
		turn: Readonly<{
			task: unknown;
			candidate: TCandidate;
			assessment: TAssessment;
			rubric: string;
			context: readonly AgentBusEntry[];
			signal?: AbortSignal;
		}>,
	) => RubricRevision<TFeedback> | Promise<RubricRevision<TFeedback>>;
	readonly signal?: AbortSignal;
}

export interface HarnessSettings<TCandidate> {
	readonly maxRounds?: number;
	readonly candidateId: (candidate: TCandidate) => string;
}

/** How many student rounds a harness runs when `maxRounds` is unset. */
export const defaultMaxRounds = 3;

export interface TrainingHarness<TCandidate, TAssessment, TFeedback> {
	run<TChallenge>(input: HarnessInput<TCandidate, TAssessment, TFeedback, TChallenge>): Promise<HarnessRun<TCandidate, TAssessment, TChallenge>>;
}

export function defineTrainingHarness<TCandidate, TAssessment, TFeedback>(
	settings: HarnessSettings<TCandidate>,
): TrainingHarness<TCandidate, TAssessment, TFeedback> {
	const maxRounds = settings.maxRounds ?? defaultMaxRounds;
	if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new TypeError("maxRounds must be a positive integer");

	return Object.freeze({
		async run<TChallenge>(input: HarnessInput<TCandidate, TAssessment, TFeedback, TChallenge>) {
			let rubric = input.rubric.trim();
			if (!rubric) throw new TypeError("judge rubric must be non-empty");
			const rounds: HarnessRound<TCandidate, TAssessment, TChallenge>[] = [];
			let feedback: readonly TFeedback[] = [];
			let previousCandidate: string | undefined;

			// Every actor invocation is written ahead and gated through the judge
			// callback; the judge itself is just one more actor whose verdicts
			// land on the bus as ordinary messages.
			const gate: ActionGate = (action, context) =>
				input.judge(Object.freeze({ subject: "action", action, context }));
			const dispatch = <T>(actor: string, kind: string, payload: unknown, execute: () => Promise<T> | T) =>
				dispatchAction(input.bus, actor, kind, payload, gate, execute);

			for (let round = 1; round <= maxRounds; round += 1) {
				input.signal?.throwIfAborted();
				const turn = await studentTurn(input, round, rubric, feedback);
				const candidate = await dispatch("student", "agent.propose", { round, task: input.task, rubric, feedback },
					() => input.student(turn));
				input.signal?.throwIfAborted();
				const candidateId = settings.candidateId(candidate).trim();
				if (!candidateId) throw new TypeError("candidateId must return a non-empty string");
				if (candidateId === previousCandidate) return result("stalled", rounds, rubric);
				previousCandidate = candidateId;

				const assessment = await dispatch("teacher", "agent.assess", { round, candidateId },
					() => input.teacher(candidate, turn));
				input.signal?.throwIfAborted();
				const candidateDecision = await decide(input, { candidateId }, {
					subject: "candidate",
					task: input.task,
					candidate,
					assessment: assessment.assessment,
					rubric,
					context: [],
				});

				if (candidateDecision === "fail") {
					rounds.push(Object.freeze({ round, candidate, assessment: assessment.assessment, judgeDecision: candidateDecision, rubric }));
					feedback = Object.freeze([...assessment.feedback]);
					continue;
				}

				const adversary = await dispatch("adversary", "agent.challenge", { candidateId }, async () =>
					input.adversary(candidate, {
						task: input.task,
						context: await input.bus.read("adversary"),
						...(input.signal === undefined ? {} : { signal: input.signal }),
					}));
				input.signal?.throwIfAborted();
				const adversaryDecision = await decide(input, { candidateId }, {
					subject: "adversary",
					task: input.task,
					candidate,
					challenge: adversary,
					rubric,
					context: [],
				});

				if (adversaryDecision === "fail") {
					rounds.push(Object.freeze({ round, candidate, assessment: assessment.assessment, judgeDecision: candidateDecision,
						adversary: Object.freeze({ challenge: adversary, decision: adversaryDecision }), rubric }));
					return result("accepted", rounds, rubric);
				}

				const revision = await dispatch("teacher", "agent.revise-rubric", { round, candidateId }, async () =>
					input.reviseRubric(adversary, {
						task: input.task,
						candidate,
						assessment: assessment.assessment,
						rubric,
						context: await input.bus.read(),
						...(input.signal === undefined ? {} : { signal: input.signal }),
					}));
				const revised = revision.rubric.trim();
				if (!revised || revised === rubric) throw new Error("teacher must improve the rubric after an approved adversarial challenge");
				rubric = revised;
				feedback = Object.freeze([...revision.feedback]);
				rounds.push(Object.freeze({ round, candidate, assessment: assessment.assessment, judgeDecision: candidateDecision,
					adversary: Object.freeze({ challenge: adversary, decision: adversaryDecision }), rubric }));
			}

			return result("exhausted", rounds, rubric);
		},
	});
}

async function studentTurn<TCandidate, TAssessment, TFeedback, TChallenge>(
	input: HarnessInput<TCandidate, TAssessment, TFeedback, TChallenge>,
	round: number,
	rubric: string,
	feedback: readonly TFeedback[],
): Promise<StudentTurn<TFeedback>> {
	return Object.freeze({
		round,
		task: input.task,
		rubric,
		feedback,
		context: await input.bus.read(),
		...(input.signal === undefined ? {} : { signal: input.signal }),
	});
}

/** Asks the judge callback and records its verdict on the bus as the judge's
 * own message — the same way any actor communicates. */
async function decide<TCandidate, TAssessment, TFeedback, TChallenge>(
	input: HarnessInput<TCandidate, TAssessment, TFeedback, TChallenge>,
	payload: Readonly<Record<string, unknown>>,
	request: JudgeRequest<TCandidate, TAssessment, TChallenge>,
): Promise<JudgeDecision> {
	const context = request.subject === "action" ? request.context : await input.bus.read();
	const decision = requireDecision(await input.judge(Object.freeze({ ...request, context })));
	await input.bus.append({
		actor: "judge",
		kind: decisionKind,
		payload: { subject: request.subject, ...payload, decision },
	});
	return decision;
}

function result<TCandidate, TAssessment, TChallenge>(
	outcome: HarnessRun<TCandidate, TAssessment, TChallenge>["outcome"],
	rounds: HarnessRound<TCandidate, TAssessment, TChallenge>[],
	rubric: string,
): HarnessRun<TCandidate, TAssessment, TChallenge> {
	return Object.freeze({ outcome, rounds: Object.freeze([...rounds]),
		final: rounds.at(-1) as HarnessRound<TCandidate, TAssessment, TChallenge>, rubric });
}
