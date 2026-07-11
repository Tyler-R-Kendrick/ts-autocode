import { createDeepAgent, type CreateDeepAgentParams } from "deepagents";

import { MxcSandbox, type MxcSandboxSettings } from "./sandbox.js";

export interface TrainingAgentSettings {
	readonly model?: CreateDeepAgentParams["model"];
	readonly student: MxcSandboxSettings;
	readonly teacher: MxcSandboxSettings;
}

export function createTrainingAgents(settings: TrainingAgentSettings) {
	const model = settings.model === undefined ? {} : { model: settings.model };
	return Object.freeze({
		student: createDeepAgent({
			...model,
			backend: new MxcSandbox(settings.student),
			systemPrompt: "Improve the requested trainable implementation. Work only in the sandbox and return a concise candidate summary.",
		}),
		teacher: createDeepAgent({
			...model,
			backend: new MxcSandbox(settings.teacher),
			systemPrompt: "Review candidate evidence produced by AgentV. Do not invent scores. Return actionable failures or an acceptance decision.",
		}),
	});
}

export type TrainingAgents = ReturnType<typeof createTrainingAgents>;
