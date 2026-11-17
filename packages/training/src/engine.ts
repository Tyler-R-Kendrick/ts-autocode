import type { EvaluationResult, EvalTestInput } from "@agentv/core";
import ts from "typescript";
import { z } from "zod";

import { digest } from "./digest.js";
import {
	CandidateSyntaxError,
	EngineContractError,
	InvalidSettingsError,
	parseSetting,
} from "./errors.js";

import type { TrainingRecord } from "./records.js";
import type { TrainableTarget } from "./source.js";
import type { TrainableId } from "./token.js";

export interface SecretProvider {
	get(name: string, signal?: AbortSignal): Promise<string | undefined>;
}

export interface BoundEvaluation {
	readonly trainableId: TrainableId;
	readonly candidateId?: string;
	readonly test?: EvalTestInput;
	readonly result: EvaluationResult;
}

export interface OptimizeRequest {
	readonly trainableId: TrainableId;
	readonly objective: string;
	readonly target: TrainableTarget;
	readonly records: readonly TrainingRecord[];
	readonly evaluations: readonly BoundEvaluation[];
	readonly constraints?: readonly string[];
}

export interface ModelSelection {
	readonly service?: unknown;
	readonly provider?: string;
	readonly name?: string;
	readonly apiKey?: string;
	readonly teacher?: Readonly<{
		readonly service?: unknown;
		readonly provider?: string;
		readonly name?: string;
		readonly apiKey?: string;
	}>;
}

export interface EngineContext {
	readonly variables: Readonly<Record<string, string>>;
	readonly secrets?: SecretProvider;
	readonly model?: ModelSelection;
	readonly signal?: AbortSignal;
}

export interface EngineCandidate {
	readonly implementation: string;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CandidatePatch extends EngineCandidate {
	readonly id: string;
	readonly trainableId: TrainableId;
	readonly engineId: string;
	readonly target: TrainableTarget;
}

export interface TrainingEngine {
	readonly id: string;
	optimize(request: OptimizeRequest, context: EngineContext): Promise<EngineCandidate>;
}

export type EngineFunction = (
	request: OptimizeRequest,
	context: EngineContext,
) => string | EngineCandidate | Promise<string | EngineCandidate>;

export function asEngine(value: TrainingEngine | EngineFunction): TrainingEngine {
	if (typeof value !== "function") return value;
	return {
		id: value.name ? `inline/${value.name}` : "inline/engine",
		async optimize(request, context) {
			const proposed = await value(request, context);
			return typeof proposed === "string" ? { implementation: proposed } : proposed;
		},
	};
}

export type ImplementationExecutor = (
	target: TrainableTarget,
	implementation: string,
	args: readonly unknown[],
	options?: Readonly<{ timeoutMs?: number; signal?: AbortSignal; receiver?: unknown }>,
) => Promise<unknown>;

const AsyncFunction = Object.getPrototypeOf(async function () {   }).constructor as FunctionConstructor;

export const directExecutor: ImplementationExecutor = async (target, implementation, args, options) => {
	const compile = target.async ? AsyncFunction : Function;
	const body = new compile(...target.parameters.map((parameter) => parameter.name), implementation) as (
		...values: unknown[]
	) => unknown;
	return body.apply(options?.receiver, [...args]);
};

export function candidateDeclaration(target: TrainableTarget, implementation: string): string {
	const parameters = target.parameters.map((parameter) => parameter.declaration).join(", ");
	return `${target.async ? "async " : ""}function candidate(${parameters}): ${target.returnType} {\n${implementation}\n}`;
}

const engineId = z.string().trim().min(1, "engine id must be a non-empty string");
const proposedImplementation = z.string({ error: "engine implementation must be a string" });

export class CandidateEngine {
	readonly #strategy: TrainingEngine;

	constructor(strategy: TrainingEngine) {
		parseSetting(engineId, strategy.id);
		this.#strategy = strategy;
	}

	async propose(request: OptimizeRequest, context: EngineContext): Promise<CandidatePatch> {
		this.#validateRequest(request);
		const proposed = await this.#strategy.optimize(structuredClone(request), context);
		const implementation = this.#cleanImplementation(proposed.implementation);
		if (!implementation) throw new EngineContractError("engine returned an empty implementation");
		this.#validateImplementation(request.target, implementation);
		const candidate = {
			id: digest({ trainableId: request.trainableId, engineId: this.#strategy.id, target: request.target, implementation }),
			trainableId: request.trainableId,
			engineId: this.#strategy.id,
			target: request.target,
			implementation,
			...(proposed.metadata === undefined ? {} : { metadata: proposed.metadata }),
		} satisfies CandidatePatch;
		return Object.freeze(structuredClone(candidate));
	}

	#validateRequest(request: OptimizeRequest): void {
		if (!request.objective.trim()) throw new InvalidSettingsError("optimization objective must be a non-empty string");
		if (request.target.id !== request.trainableId) throw new EngineContractError("trainable target must match the request id");
		if (request.records.some((record) => record.trainableId !== request.trainableId)) {
			throw new EngineContractError("training records must match the request id");
		}
		if (request.evaluations.some((evaluation) => evaluation.trainableId !== request.trainableId)) {
			throw new EngineContractError("evaluations must match the request id");
		}
	}

	#cleanImplementation(value: string): string {
		return parseSetting(proposedImplementation, value)
			.trim().replace(/^```(?:typescript|ts|javascript|js)?\s*/i, "").replace(/\s*```$/, "").trim();
	}

	#validateImplementation(target: TrainableTarget, implementation: string): void {
		const diagnostics = ts.transpileModule(candidateDeclaration(target, implementation), {
			compilerOptions: { target: ts.ScriptTarget.ES2022 },
			reportDiagnostics: true,
		}).diagnostics ?? [];
		if (diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
			throw new CandidateSyntaxError(target.id);
		}
	}
}
