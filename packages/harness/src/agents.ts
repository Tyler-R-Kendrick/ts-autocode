import { createDeepAgent, type CreateDeepAgentParams } from "deepagents";

import {
	parseJudgeDecision,
	WriteAheadAgentBus,
	type AgentBusSettings,
	type AgentRole,
} from "./bus.js";
import {
	evolvePrompts,
	type AgentEvolutionSettings,
	type EvolutionComponent,
	type GepaSettings,
} from "./evolution.js";
import type { HarnessInput, RubricRevision, StudentTurn, TeacherResult } from "./index.js";
import { MxcSandbox, type MxcSandboxSettings } from "./sandbox.js";

export interface TrainingAgentRoleSettings {
	readonly sandbox: Omit<MxcSandboxSettings, "bus" | "role">;
	readonly model?: CreateDeepAgentParams["model"];
	readonly systemPrompt?: string;
	readonly evolution?: AgentEvolutionSettings;
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
	readonly gepa?: GepaSettings;
	readonly student: TrainingAgentRoleSettings;
	readonly teacher: TrainingAgentRoleSettings;
	readonly judge: TrainingAgentRoleSettings;
	readonly adversary: TrainingAgentRoleSettings;
	readonly outputs: TrainingAgentOutputs<TCandidate, TAssessment, TFeedback, TChallenge>;
}

export function createTrainingAgents<TCandidate, TAssessment, TFeedback, TChallenge>(
	settings: TrainingAgentSettings<TCandidate, TAssessment, TFeedback, TChallenge>,
): Pick<HarnessInput<TCandidate, TAssessment, TFeedback, TChallenge>,
	"bus" | "evolve" | "student" | "teacher" | "judge" | "adversary" | "reviseRubric"> {
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
		evolve: async () => {
			const evolution = [
				component(student, settings.student.evolution, studentEvolutionPrompt, settings.outputs.student),
				component(teacher, settings.teacher.evolution, teacherEvolutionPrompt, async (result, input) =>
					isRevisionInput(input) ? settings.outputs.revision(result) : settings.outputs.teacher(result)),
				component(judge, settings.judge.evolution, judgePrompt, async (result) => parseJudgeDecision(result)),
				component(adversary, settings.adversary.evolution, adversaryEvolutionPrompt, settings.outputs.adversary),
			].filter((entry): entry is EvolutionComponent => entry !== undefined);
			if (evolution.length === 0) return;
			await bus.dispatch("teacher", "agent.evolve", { roles: evolution.map(({ name }) => name) }, async () => {
				const prompts = await evolvePrompts(evolution, settings.gepa);
				for (const role of [student, teacher, judge, adversary]) {
					const prompt = prompts[role.name];
					if (prompt) role.setPrompt(prompt);
				}
			});
		},
		student: async (turn) => settings.outputs.student(await student.invoke(studentPrompt(turn))),
		teacher: async (candidate, turn) => settings.outputs.teacher(await teacher.invoke(teacherPrompt(candidate, turn))),
		judge: async (input) => parseJudgeDecision(await judge.invoke(judgePrompt(input))),
		adversary: async (candidate, turn) => settings.outputs.adversary(await adversary.invoke(adversaryPrompt(candidate, turn))),
		reviseRubric: async (challenge, turn) => settings.outputs.revision(await teacher.invoke(revisionPrompt(challenge, turn))),
	});
}

interface EvolvingRole {
	readonly name: AgentRole;
	readonly prompt: string;
	invoke(content: string): Promise<unknown>;
	run(input: unknown, systemPrompt: string, render: (input: unknown) => string): Promise<unknown>;
	setPrompt(prompt: string): void;
}

function createRole(
	role: AgentRole,
	settings: TrainingAgentRoleSettings,
	bus: WriteAheadAgentBus,
	defaultModel: CreateDeepAgentParams["model"] | undefined,
	defaultPrompt: string,
): EvolvingRole {
	const model = settings.model ?? defaultModel;
	let systemPrompt = settings.systemPrompt ?? defaultPrompt;
	let agent = buildAgent(role, settings.sandbox, bus, model, systemPrompt);
	return {
		name: role,
		get prompt() { return systemPrompt; },
		invoke: (content) => agent.invoke(message(content)),
		run: (input, candidatePrompt, render) =>
			buildAgent(role, settings.sandbox, bus, model, candidatePrompt).invoke(message(render(input))),
		setPrompt(prompt) {
			systemPrompt = prompt;
			agent = buildAgent(role, settings.sandbox, bus, model, prompt);
		},
	};
}

function buildAgent(
	role: AgentRole,
	sandbox: Omit<MxcSandboxSettings, "bus" | "role">,
	bus: WriteAheadAgentBus,
	model: CreateDeepAgentParams["model"] | undefined,
	systemPrompt: string,
) {
	return createDeepAgent({
		...(model === undefined ? {} : { model }),
		systemPrompt,
		backend: new MxcSandbox({ ...sandbox, bus, role }),
	});
}

function component(
	agent: EvolvingRole,
	evolution: AgentEvolutionSettings | undefined,
	render: (input: unknown) => string,
	decode: (result: unknown, input: unknown) => unknown | Promise<unknown>,
): EvolutionComponent | undefined {
	if (!evolution) return undefined;
	return {
		name: agent.name,
		seed: agent.prompt,
		settings: evolution,
		run: async (input, systemPrompt) => decode(await agent.run(input, systemPrompt, render), input),
	};
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

function studentEvolutionPrompt(input: unknown): string {
	return studentPrompt(input as StudentTurn<unknown>);
}

function teacherEvolutionPrompt(input: unknown): string {
	if (isRevisionInput(input)) return revisionPrompt(input.challenge, input.turn);
	const assessment = input as { candidate: unknown; turn: StudentTurn<unknown> };
	return teacherPrompt(assessment.candidate, assessment.turn);
}

function adversaryEvolutionPrompt(input: unknown): string {
	const challenge = input as { candidate: unknown; turn: { task: unknown; context: unknown } };
	return adversaryPrompt(challenge.candidate, challenge.turn);
}

function isRevisionInput(input: unknown): input is {
	readonly operation: "revision";
	readonly challenge: unknown;
	readonly turn: Parameters<typeof revisionPrompt>[1];
} {
	return typeof input === "object" && input !== null && "operation" in input && input.operation === "revision";
}

function json(value: unknown): string {
	return JSON.stringify(value, null, 2) ?? String(value);
}
