import { createDeepAgent, type CreateDeepAgentParams } from "deepagents";

import { parseJudgeDecision, WriteAheadAgentBus, type AgentBusSettings, type AgentRole } from "./bus.js";
import type { HarnessInput, RubricRevision, StudentTurn, TeacherResult } from "./index.js";
import { MxcSandbox, type MxcSandboxSettings } from "./sandbox.js";

export interface TrainingAgentRoleSettings {
	readonly sandbox: Omit<MxcSandboxSettings, "bus" | "role">;
	readonly model?: CreateDeepAgentParams["model"];
	readonly systemPrompt?: string;
}

export interface TrainingAgentOutputs<TCandidate, TAssessment, TFeedback, TChallenge> {
	readonly student: (result: unknown) => TCandidate | Promise<TCandidate>;
	readonly teacher: (result: unknown) => TeacherResult<TAssessment, TFeedback> | Promise<TeacherResult<TAssessment, TFeedback>>;
	readonly adversary: (result: unknown) => TChallenge | Promise<TChallenge>;
	readonly revision: (result: unknown) => RubricRevision<TFeedback> | Promise<RubricRevision<TFeedback>>;
}

export interface TrainingAgentSettings<TCandidate, TAssessment, TFeedback, TChallenge> {
	readonly bus: AgentBusSettings;
	readonly model?: CreateDeepAgentParams["model"];
	readonly student: TrainingAgentRoleSettings;
	readonly teacher: TrainingAgentRoleSettings;
	readonly judge: TrainingAgentRoleSettings;
	readonly adversary: TrainingAgentRoleSettings;
	readonly outputs: TrainingAgentOutputs<TCandidate, TAssessment, TFeedback, TChallenge>;
}

export type TrainingAgentCallbacks<TCandidate, TAssessment, TFeedback, TChallenge> =
	Pick<HarnessInput<TCandidate, TAssessment, TFeedback, TChallenge>,
	"student" | "teacher" | "judge" | "adversary" | "reviseRubric">;

export function createTrainingAgents<TCandidate, TAssessment, TFeedback, TChallenge>(
	settings: TrainingAgentSettings<TCandidate, TAssessment, TFeedback, TChallenge>,
): TrainingAgentCallbacks<TCandidate, TAssessment, TFeedback, TChallenge> &
	Pick<HarnessInput<TCandidate, TAssessment, TFeedback, TChallenge>, "bus"> {
	const bus = new WriteAheadAgentBus(settings.bus);
	const student = createRole("student", settings.student, bus, settings.model,
		"Improve the requested trainable implementation using the rubric, teacher feedback, and prior action history.");
	const teacher = createRole("teacher", settings.teacher, bus, settings.model,
		"Assess objective evidence and maintain the judge rubric. When an approved adversarial challenge exposes a gap, revise the rubric.");
	const judge = createRole("judge", settings.judge, bus, settings.model,
		"Evaluate any supplied input. Return exactly pass or fail. Never explain a failure or provide feedback.");
	const adversary = createRole("adversary", settings.adversary, bus, settings.model,
		"Analyze only the supplied artifact and task. Find a concrete counterexample or failure without assuming any surrounding process.");

	return Object.freeze({
		bus,
		student: async (turn) => settings.outputs.student(await student.invoke(message(studentPrompt(turn)))),
		teacher: async (candidate, turn) => settings.outputs.teacher(await teacher.invoke(message(teacherPrompt(candidate, turn)))),
		judge: async (input) => parseJudgeDecision(await judge.invoke(message(judgePrompt(input)))),
		adversary: async (candidate, turn) => settings.outputs.adversary(await adversary.invoke(message(adversaryPrompt(candidate, turn)))),
		reviseRubric: async (challenge, turn) => settings.outputs.revision(await teacher.invoke(message(revisionPrompt(challenge, turn)))),
	});
}

function createRole(
	role: AgentRole,
	settings: TrainingAgentRoleSettings,
	bus: WriteAheadAgentBus,
	defaultModel: CreateDeepAgentParams["model"] | undefined,
	defaultPrompt: string,
) {
	const model = settings.model ?? defaultModel;
	return createDeepAgent({
		...(model === undefined ? {} : { model }),
		systemPrompt: settings.systemPrompt ?? defaultPrompt,
		backend: new MxcSandbox({ ...settings.sandbox, bus, role }),
	});
}

function message(content: string) {
	return { messages: [{ role: "user" as const, content }] };
}

function studentPrompt<TFeedback>(turn: StudentTurn<TFeedback>): string {
	return `Propose the next candidate.\nTask: ${json(turn.task)}\nRubric: ${turn.rubric}\nTeacher feedback: ${json(turn.feedback)}\nRecent actions: ${json(turn.context)}`;
}

function teacherPrompt(candidate: unknown, turn: StudentTurn<unknown>): string {
	return `Assess the candidate against objective evidence.\nTask: ${json(turn.task)}\nCandidate: ${json(candidate)}\nRubric: ${turn.rubric}\nRecent actions: ${json(turn.context)}`;
}

function judgePrompt(input: unknown): string {
	return `Evaluate this input. Return exactly pass or fail and nothing else.\n${json(input)}`;
}

function adversaryPrompt(candidate: unknown, turn: { task: unknown; context: unknown }): string {
	return `Find a concrete failure or counterexample for this artifact.\nTask: ${json(turn.task)}\nArtifact: ${json(candidate)}\nYour prior actions: ${json(turn.context)}`;
}

function revisionPrompt(challenge: unknown, turn: { task: unknown; candidate: unknown; assessment: unknown; rubric: string; context: unknown }): string {
	return `Revise the judge rubric because an adversarial challenge was approved.\nTask: ${json(turn.task)}\nCandidate: ${json(turn.candidate)}\nAssessment: ${json(turn.assessment)}\nChallenge: ${json(challenge)}\nCurrent rubric: ${turn.rubric}\nRecent actions: ${json(turn.context)}`;
}

function json(value: unknown): string {
	return JSON.stringify(value, null, 2) ?? String(value);
}
