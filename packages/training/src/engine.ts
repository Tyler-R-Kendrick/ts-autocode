import type { EvaluationResult, EvalTestInput } from "@agentv/core";
import ts from "typescript";

import { digest } from "./digest.js";

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

export interface EngineContext {
	readonly variables: Readonly<Record<string, string>>;
	readonly secrets?: SecretProvider;
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

/** Provider-neutral optimizer strategy. Ax is the default implementation, not
 * the interface. Overrides are composed, never inherited: the runtime wraps
 * whatever strategy is configured in a `CandidateEngine`. */
export interface TrainingEngine {
	readonly id: string;
	optimize(request: OptimizeRequest, context: EngineContext): Promise<EngineCandidate>;
}

/** Runs a proposed implementation against arguments in provider-owned isolation.
 * `receiver` is the live `this` when a hot-swapped instance method is invoked;
 * sandboxed executors may ignore it. */
export type ImplementationExecutor = (
	target: TrainableTarget,
	implementation: string,
	args: readonly unknown[],
	options?: Readonly<{ timeoutMs?: number; signal?: AbortSignal; receiver?: unknown }>,
) => Promise<unknown>;

/** The synthetic `function candidate(...)` declaration that wraps a proposed body.
 * Executors transpile and run exactly what the engine validated. */
export function candidateDeclaration(target: TrainableTarget, implementation: string): string {
	const parameters = target.parameters.map((parameter) => parameter.declaration).join(", ");
	return `${target.async ? "async " : ""}function candidate(${parameters}): ${target.returnType} {\n${implementation}\n}`;
}

/** The engine proper. It owns request validation, implementation cleanup,
 * TypeScript validation, and candidate identity; the proposal itself is
 * delegated to the composed optimizer strategy. Consumers never extend this
 * pipeline — they supply a `TrainingEngine` strategy and the runtime wraps it. */
export class CandidateEngine {
	readonly #strategy: TrainingEngine;

	constructor(strategy: TrainingEngine) {
		if (!strategy.id.trim()) throw new TypeError("engine id must be a non-empty string");
		this.#strategy = strategy;
	}

	async propose(request: OptimizeRequest, context: EngineContext): Promise<CandidatePatch> {
		this.#validateRequest(request);
		const proposed = await this.#strategy.optimize(structuredClone(request), context);
		const implementation = this.#cleanImplementation(proposed.implementation);
		if (!implementation) throw new Error("engine returned an empty implementation");
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
		if (!request.objective.trim()) throw new TypeError("optimization objective must be a non-empty string");
		if (request.target.id !== request.trainableId) throw new Error("trainable target must match the request id");
		if (request.records.some((record) => record.trainableId !== request.trainableId)) {
			throw new Error("training records must match the request id");
		}
		if (request.evaluations.some((evaluation) => evaluation.trainableId !== request.trainableId)) {
			throw new Error("evaluations must match the request id");
		}
	}

	#cleanImplementation(value: string): string {
		if (typeof value !== "string") throw new TypeError("engine implementation must be a string");
		return value.trim().replace(/^```(?:typescript|ts|javascript|js)?\s*/i, "").replace(/\s*```$/, "").trim();
	}

	#validateImplementation(target: TrainableTarget, implementation: string): void {
		const diagnostics = ts.transpileModule(candidateDeclaration(target, implementation), {
			compilerOptions: { target: ts.ScriptTarget.ES2022 },
			reportDiagnostics: true,
		}).diagnostics ?? [];
		if (diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
			throw new SyntaxError(`engine returned invalid TypeScript for ${target.id}`);
		}
	}
}
