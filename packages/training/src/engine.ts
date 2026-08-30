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

/** Which model an engine should use. Provider-neutral on purpose: this package
 * knows nothing about any provider and simply carries the descriptor to the
 * configured engine, exactly as it carries `variables` and `secrets`. The
 * default Ax engine interprets `provider` as an Ax provider name.
 *
 * Choosing a model previously meant constructing a whole replacement engine,
 * which is a lot of ceremony for the first thing most users want to change. */
export interface ModelSelection {
	/** A pre-built client the configured engine should use directly -- the
	 * escape hatch that makes the library responsible for *no* provider list.
	 * Carried opaquely, like `variables`: this package never calls it, and the
	 * engine defines what it accepts (the default Ax engine takes any
	 * `AxAIService`, or a factory returning one). When set, `provider`,
	 * `name` and `apiKey` are that client's concern, not this library's. */
	readonly service?: unknown;
	/** Provider id, resolved by the configured engine, e.g. `"openai"`,
	 * `"anthropic"`, `"google-gemini"`. The default Ax engine hands it to Ax's
	 * own provider registry, so any provider Ax supports works here -- this
	 * library maintains no list of its own. For anything beyond that registry,
	 * supply {@link ModelSelection.service}. */
	readonly provider?: string;
	/** Model id, e.g. `"gpt-4o-mini"`. Unset uses the provider's own default. */
	readonly name?: string;
	/** API key. Falls back to the secret provider, then the environment. */
	readonly apiKey?: string;
	/** An optional stronger model for the optimizer's teacher role. */
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
	/** The configured {@link ModelSelection}, when one was given. */
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

/** Provider-neutral optimizer strategy. Ax is the default implementation, not
 * the interface. Overrides are composed, never inherited: the runtime wraps
 * whatever strategy is configured in a `CandidateEngine`. */
export interface TrainingEngine {
	readonly id: string;
	optimize(request: OptimizeRequest, context: EngineContext): Promise<EngineCandidate>;
}

/** A bare function accepted anywhere a {@link TrainingEngine} is: return the
 * replacement body (or a full candidate) and the runtime derives the rest.
 * The `{ id, optimize }` object form exists for engines with an identity worth
 * publishing; requiring it of an inline lambda was ceremony. */
export type EngineFunction = (
	request: OptimizeRequest,
	context: EngineContext,
) => string | EngineCandidate | Promise<string | EngineCandidate>;

/** Normalizes either engine spelling to the object form. */
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

/** Runs a proposed implementation against arguments in provider-owned isolation.
 * `receiver` is the live `this` when a hot-swapped instance method is invoked;
 * sandboxed executors may ignore it. */
export type ImplementationExecutor = (
	target: TrainableTarget,
	implementation: string,
	args: readonly unknown[],
	options?: Readonly<{ timeoutMs?: number; signal?: AbortSignal; receiver?: unknown }>,
) => Promise<unknown>;

const AsyncFunction = Object.getPrototypeOf(async function () { /* shape only */ }).constructor as FunctionConstructor;

/** Runs a candidate body directly with `new Function` -- no sandbox, no
 * timeout, full access to the process. The executor every test double in this
 * repo reimplemented by hand; exported so nobody else has to. Use it only
 * where the candidate is trusted -- tests and local development loops. The
 * executor the root package wires by default runs candidates in isolation. */
export const directExecutor: ImplementationExecutor = async (target, implementation, args, options) => {
	// An async target's candidates may legitimately contain `await` -- the
	// engine validates them against an async declaration -- so they must be
	// compiled as async functions, not thrown at a sync Function constructor.
	const compile = target.async ? AsyncFunction : Function;
	const body = new compile(...target.parameters.map((parameter) => parameter.name), implementation) as (
		...values: unknown[]
	) => unknown;
	return body.apply(options?.receiver, [...args]);
};

/** The synthetic `function candidate(...)` declaration that wraps a proposed body.
 * Executors transpile and run exactly what the engine validated. */
export function candidateDeclaration(target: TrainableTarget, implementation: string): string {
	const parameters = target.parameters.map((parameter) => parameter.declaration).join(", ");
	return `${target.async ? "async " : ""}function candidate(${parameters}): ${target.returnType} {\n${implementation}\n}`;
}

const engineId = z.string().trim().min(1, "engine id must be a non-empty string");
const proposedImplementation = z.string({ error: "engine implementation must be a string" });

/** The engine proper. It owns request validation, implementation cleanup,
 * TypeScript validation, and candidate identity; the proposal itself is
 * delegated to the composed optimizer strategy. Consumers never extend this
 * pipeline — they supply a `TrainingEngine` strategy and the runtime wraps it. */
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
