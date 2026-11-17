import { randomUUID } from "node:crypto";

import { buildTraceFromMessages, getTextContent, type EvalConfig, type EvalTestInput } from "@agentv/core";
import { z } from "zod";
import { OpenInferenceSpanKind, SemanticConventions } from "@arizeai/openinference-semantic-conventions";
import { SpanStatusCode, trace, type Attributes, type Span, type Tracer } from "@opentelemetry/api";

import { attempt, errorMessage } from "./attempt.js";
import { optional } from "./optional.js";
import {
	EngineNotConfiguredError,
	ExecutorNotConfiguredError,
	InsufficientTracesError,
	parseSetting,
	positiveIntegerSetting,
	PromotionApplierNotConfiguredError,
	PromotionRejectedError,
	TraceNotFoundError,
	TrainingIncompleteError,
} from "./errors.js";
import {
	asEngine,
	CandidateEngine,
	type BoundEvaluation,
	type CandidatePatch,
	type EngineFunction,
	type ImplementationExecutor,
	type ModelSelection,
	type SecretProvider,
	type TrainingEngine,
} from "./engine.js";
import { withPolicy, type ResilienceSettings } from "./resilience.js";
import { evaluateTrainable, type TrainableEvalRun } from "./evaluation.js";
import { sequentialLoop, type TrainingLoop, type TrainingRound } from "./loop.js";
import {
	defaultMinPassRate,
	defaultMinScore,
	evaluatePromotionGate,
	type PromotionDecision,
	type PromotionGate,
} from "./promotion.js";
import { MemoryTrainingStore, type TrainingRecord, type TrainingStore } from "./records.js";
import {
	findTrainable,
	type SourceSettings,
} from "./source.js";
import {
	defineTrainable,
	toTrainableToken,
	type TrainableIdentity,
	type TrainableToken,
} from "./token.js";

const trainableAttribute = "ts_autocode.trainable.id";
const tracerName = "ts-autocode";
const traceMinimum = positiveIntegerSetting("minTraces must be a positive integer");
const executionTimeout = z.number().positive("execution.timeoutMs must be a positive number of milliseconds").finite("execution.timeoutMs must be a positive number of milliseconds");

export interface CaptureSettings {
	readonly enabled?: boolean;
	readonly serialize?: (value: unknown) => string;
	readonly mapInput?: (args: readonly unknown[], trainable: TrainableToken) => unknown;
	readonly mapOutput?: (result: unknown, trainable: TrainableToken) => unknown;
}

export interface TracingSettings {
	readonly enabled?: boolean;
	readonly tracer?: Tracer;
	readonly kind?: OpenInferenceSpanKind;
	readonly attributes?: Attributes;
}

export interface EvolutionSettings {
	readonly auto?: boolean;
	/** @deprecated Renamed to {@link EvolutionSettings.auto}. `enabled` read as
	 * an opt-out switch like its two siblings while being the only opt-in one.
	 * Still honored; `auto` wins when both are set. */
	readonly enabled?: boolean;
	readonly minTraces?: number;
	readonly objective?: string;
	readonly evaluation?: Omit<EvalConfig, "specFile" | "target" | "task" | "tests">;
	readonly onEvolved?: (activation: Activation) => void;
}

export const defaultEvolution: Required<Pick<EvolutionSettings, "minTraces">> = Object.freeze({
	minTraces: 3,
});

export const defaultObjective = "Preserve behavior demonstrated by the evaluation cases";

export const defaultOutputDir = ".agentv";

export interface ExecutionSettings {
	readonly timeoutMs?: number;
	readonly decodeArgs?: (input: string) => readonly unknown[];
}

export interface TrainingSettings {
	readonly engine?: TrainingEngine | EngineFunction;
	readonly executor?: ImplementationExecutor;
	readonly execution?: ExecutionSettings;
	readonly loop?: TrainingLoop;
	readonly promote?: Promoter;
	readonly evolution?: EvolutionSettings;
	readonly outputDir?: string;
	readonly source?: SourceSettings;
	readonly store?: TrainingStore;
	readonly secrets?: SecretProvider;
	readonly model?: ModelSelection;
	readonly variables?: Readonly<Record<string, string>>;
	readonly capture?: CaptureSettings;
	readonly tracing?: TracingSettings;
	readonly resilience?: ResilienceSettings;
	readonly onEvent?: (event: TrainingEvent) => void;
	/** @deprecated Use {@link TrainingSettings.onEvent}, which reports the same
	 * failures alongside evolution lifecycle events. Still supported: it is
	 * called for every event carrying an `error`. */
	readonly onError?: (error: unknown, phase: ErrorPhase) => void;
}

export type ErrorPhase = "capture" | "store" | "evolve";

export type TrainingEvent =
	| Readonly<{ type: "capture.failed"; phase: "capture"; trainable?: TrainableToken; error: unknown }>
	| Readonly<{ type: "store.failed"; phase: "store"; error: unknown }>
	| Readonly<{ type: "evolution.started"; phase: "evolve"; trainable: TrainableToken; traces: number }>
	| Readonly<{ type: "evolution.applied"; phase: "evolve"; trainable: TrainableToken; activation: Activation }>
	| Readonly<{ type: "evolution.skipped"; phase: "evolve"; trainable: TrainableToken; traces: number; required: number }>
	| Readonly<{ type: "evolution.failed"; phase: "evolve"; trainable: TrainableToken; error: unknown }>;

export interface RoundSettings {
	readonly max?: number;
	readonly fanOut?: number;
}

export interface PromotionSettings {
	readonly minScore?: number;
	readonly minPassRate?: number;
	readonly gates?: readonly PromotionGate[];
}

export interface TrainInput {
	readonly trainable: TrainableIdentity;
	readonly objective?: string;
	readonly evaluation?: EvalConfig;
	readonly minTraces?: number;
	readonly constraints?: readonly string[];
	readonly engine?: TrainingEngine | EngineFunction;
	readonly signal?: AbortSignal;
	readonly cases?: ReadonlyArray<readonly [input: unknown, expected: unknown]>;
	readonly rounds?: RoundSettings;
	readonly promotion?: PromotionSettings;
	/** @deprecated Use `rounds.max`. */
	readonly maxRounds?: number;
	/** @deprecated Use `rounds.fanOut`. */
	readonly fanOut?: number;
	/** @deprecated Use `promotion.minScore`. */
	readonly minScore?: number;
	/** @deprecated Use `promotion.minPassRate`. */
	readonly minPassRate?: number;
	/** @deprecated Use `promotion.gates`; a policy is a gate that returns a
	 * failure when it refuses. Still honored, and still runs before the extra
	 * gates. */
	readonly policy?: (candidate: CandidatePatch) => boolean | Promise<boolean>;
	/** @deprecated Use `promotion.gates`. */
	readonly gates?: readonly PromotionGate[];
}

function resolved(input: TrainInput): {
	readonly maxRounds: number | undefined;
	readonly fanOut: number | undefined;
	readonly minScore: number | undefined;
	readonly minPassRate: number | undefined;
	readonly gates: readonly PromotionGate[] | undefined;
} {
	const gates = [...(input.promotion?.gates ?? []), ...(input.gates ?? [])];
	return {
		maxRounds: input.rounds?.max ?? input.maxRounds,
		fanOut: input.rounds?.fanOut ?? input.fanOut,
		minScore: input.promotion?.minScore ?? input.minScore,
		minPassRate: input.promotion?.minPassRate ?? input.minPassRate,
		gates: gates.length === 0 ? undefined : gates,
	};
}

export type ActivationReadiness =
	| Readonly<{ ready: true }>
	| Readonly<{ ready: false; outcome: TrainingRun["outcome"]; failures: readonly string[] }>;

export interface TrainingRun {
	readonly outcome: "ready" | "stalled" | "exhausted";
	readonly baseline: TrainableEvalRun;
	readonly rounds: readonly TrainingRound[];
	readonly final: TrainingRound;
	canActivate(): ActivationReadiness;
	activate(): Promise<Activation>;
}

export interface Activation {
	readonly run: TrainingRun;
	rollback(): Promise<void>;
}

export interface AppliedPromotion {
	rollback(): Promise<void>;
}

export type Promoter = (
	candidate: CandidatePatch,
	decision: PromotionDecision,
	executor?: ImplementationExecutor,
) => Promise<AppliedPromotion>;

/** @deprecated Renamed to {@link Promoter}, the agent noun its four sibling
 * seams already use (engine, executor, loop, store). Structurally identical;
 * existing implementations need no change. */
export type PromotionApplier = Promoter;

type CandidateEvalConfig = Omit<EvalConfig, "task"> & { readonly signal?: AbortSignal };

export interface Training {
	records(trainable?: TrainableIdentity): Promise<readonly TrainingRecord[]>;
	evaluate(trainable: TrainableIdentity, config: EvalConfig): Promise<TrainableEvalRun>;
	train(trainable: TrainableIdentity, input?: Omit<TrainInput, "trainable">): Promise<TrainingRun>;
	train(input: TrainInput): Promise<TrainingRun>;
	capture<This, Args extends unknown[], Result>(
		trainable: TrainableIdentity,
		methodName: string,
		thisValue: This,
		method: (this: This, ...args: Args) => Result,
		args: Args,
	): Result;
	flush(): Promise<void>;
}

class TrainingRuntime implements Training {
	readonly #settings: TrainingSettings;
	readonly #variables: Readonly<Record<string, string>>;
	readonly #store: TrainingStore;
	readonly #tracer: Tracer;
	#engine: CandidateEngine | undefined;
	readonly #pending = new Set<Promise<void>>();
	readonly #evaluations = new Map<string, BoundEvaluation[]>();
	readonly #evolutionState = new Map<string, { running: boolean; queued: boolean; attempted: number }>();

	constructor(settings: TrainingSettings) {
		this.#settings = settings;
		this.#variables = Object.freeze({ ...settings.variables });
		this.#store = settings.store ?? new MemoryTrainingStore();
		this.#tracer = settings.tracing?.tracer ?? trace.getTracer(tracerName);
	}

	#engineFor(override?: TrainingEngine | EngineFunction): CandidateEngine {
		if (override) return new CandidateEngine(asEngine(override));
		if (!this.#engine) {
			const configured = this.#settings.engine;
			const strategy = (configured ? asEngine(configured) : undefined) ?? defaultProviders.engine?.();
			if (!strategy) {
				throw new EngineNotConfiguredError();
			}
			this.#engine = new CandidateEngine(strategy);
		}
		return this.#engine;
	}

	#executorOrThrow(): ImplementationExecutor {
		const executor = this.#settings.executor ?? defaultProviders.executor;
		if (!executor) {
			throw new ExecutorNotConfiguredError();
		}
		return executor;
	}

	#maybeEvolve(token: TrainableToken): void {
		const evolution = this.#settings.evolution ?? defaultProviders.evolution;
		if (evolution === undefined) return;
		if ((evolution.auto ?? evolution.enabled) !== true) return;
		const state = this.#evolutionState.get(token.id) ?? { running: false, queued: false, attempted: 0 };
		this.#evolutionState.set(token.id, state);
		if (state.running) {
			state.queued = true;
			return;
		}
		state.running = true;
		void (async () => {
			await this.flush();
			const minTraces = Math.max(1, evolution.minTraces ?? defaultEvolution.minTraces);
			const successes = (await this.#store.list(token.id)).filter((record) => record.succeeded).length;
			const required = state.attempted + minTraces;
			if (successes < required) {
				this.#emit({ type: "evolution.skipped", phase: "evolve", trainable: token, traces: successes, required });
				return;
			}
			state.attempted = successes;
			this.#emit({ type: "evolution.started", phase: "evolve", trainable: token, traces: successes });
			const run = await this.train({
				trainable: token,
				minTraces,
				...optional("objective", evolution.objective),
				...optional("evaluation", evolution.evaluation),
			});
			if (run.outcome !== "ready") {
				throw TrainingIncompleteError.noPromotableCandidate(run.outcome);
			}
			const activation = await run.activate();
			this.#emit({ type: "evolution.applied", phase: "evolve", trainable: token, activation });
			evolution.onEvolved?.(activation);
		})()
			.catch((error: unknown) => {
				this.#emit({ type: "evolution.failed", phase: "evolve", trainable: token, error });
			})
			.finally(() => {
				state.running = false;
				if (state.queued) {
					state.queued = false;
					this.#maybeEvolve(token);
				}
			});
	}

	async records(identity?: TrainableIdentity): Promise<readonly TrainingRecord[]> {
		await this.flush();
		return this.#store.list(identity === undefined ? undefined : toTrainableToken(identity).id);
	}

	async evaluate(identity: TrainableIdentity, config: EvalConfig): Promise<TrainableEvalRun> {
		const token = toTrainableToken(identity);
		const run = await evaluateTrainable(token, config);
		this.#remember(run);
		return run;
	}

	async #evaluateCandidate(candidate: CandidatePatch, config: CandidateEvalConfig): Promise<TrainableEvalRun> {
		const token = defineTrainable(candidate.trainableId);
		const execute = this.#executorOrThrow();
		const timeoutMs = this.#settings.execution?.timeoutMs === undefined
			? undefined
			: parseSetting(executionTimeout, this.#settings.execution.timeoutMs);
		const decodeArgs = this.#settings.execution?.decodeArgs ?? evaluationArgs;
		const { signal, ...evaluation } = config;
		signal?.throwIfAborted();
		const evaluated = await evaluateTrainable(token, {
			...evaluation,
			task: async (input) => {
				const output = await withPolicy(
					this.#settings.resilience?.evaluate,
					"candidate.execute",
					(attemptSignal) => execute(
						candidate.target,
						candidate.implementation,
						decodeArgs(input),
						{
							...optional("timeoutMs", timeoutMs),
							...optional("signal", attemptSignal),
						},
					),
					signal,
				);
				return typeof output === "string" ? output : JSON.stringify(output) ?? String(output);
			},
		});
		const run: TrainableEvalRun = Object.freeze({
			token: evaluated.token,
			run: evaluated.run,
			evaluations: evaluated.evaluations.map((evaluation) => ({ ...evaluation, candidateId: candidate.id })),
		});
		this.#remember(run);
		return run;
	}

	async train(first: TrainInput | TrainableIdentity, rest?: Omit<TrainInput, "trainable">): Promise<TrainingRun> {
		const input: TrainInput = typeof first === "object" && first !== null && "trainable" in first
			? first as TrainInput
			: { ...rest, trainable: first as TrainableIdentity };
		const token = toTrainableToken(input.trainable);
		const objective = input.objective ?? defaultObjective;
		const evaluation = input.evaluation?.tests ? input.evaluation
			: input.cases ? casesEvaluation(input.cases, input.evaluation)
			: await this.#replayEvaluation(token, input);
		const { task: _task, outputDir = this.#settings.outputDir ?? defaultOutputDir, ...candidateEvaluation } = evaluation;
		const baseline = await this.evaluate(token, { ...evaluation, outputDir });
		const loop = this.#settings.loop ?? defaultProviders.loop ?? sequentialLoop;
		const options = resolved(input);
		const result = await loop({
			trainableId: token.id,
			objective,
			rubric: promotionRubric(input),
			outputDir,
			...optional("maxRounds", options.maxRounds),
			...optional("fanOut", options.fanOut),
			...optional("signal", input.signal),
			propose: ({ feedback, signal }) => this.#propose(token, {
				objective,
				constraints: [
					...(input.constraints ?? []),
					...feedback.map((failure) => `Previous candidate rejection: ${failure}`),
				],
				...optional("engine", input.engine),
				...optional("signal", signal),
			}),
			review: async (candidate, { label, signal }) => {
				const verification = await this.#evaluateCandidate(candidate, {
					...candidateEvaluation,
					...optional("signal", signal),
					outputDir: `${outputDir}/${label}`,
				});
				const decision = await evaluatePromotionGate({
					candidate,
					evaluations: verification.evaluations,
					conformance: true,
					...optional("minScore", options.minScore),
					...optional("minPassRate", options.minPassRate),
					...optional("policy", input.policy),
					...optional("gates", options.gates),
				});
				return { verification, decision };
			},
		});
		const final = result.rounds.at(-1);
		if (!final) throw TrainingIncompleteError.noRounds(result.outcome);
		const run: TrainingRun = Object.freeze({
			outcome: result.outcome,
			baseline,
			rounds: Object.freeze([...result.rounds]),
			final,
			canActivate: () => activationReadiness(run, () => (this.#settings.promote ?? defaultProviders.promote) !== undefined),
			activate: () => this.#activate(run),
		});
		return run;
	}

	async #replayEvaluation(token: TrainableToken, input: TrainInput): Promise<EvalConfig> {
		const minTraces = parseSetting(traceMinimum, input.minTraces ?? 1);
		const tests = liveEvalCases(await this.records(token));
		if (tests.length < minTraces) {
			throw new InsufficientTracesError(minTraces, tests.length);
		}
		const expected = new Map(tests.map((test) => [String(test.input), test.expectedOutput ?? ""]));
		return {
			...input.evaluation,
			tests,
			task: (value) => {
				const output = expected.get(value);
				if (output === undefined) throw new TraceNotFoundError(value);
				return output;
			},
		};
	}

	#remember(run: TrainableEvalRun): void {
		const token = run.token;
		const evaluations = this.#evaluations.get(token.id) ?? [];
		evaluations.push(...run.evaluations);
		this.#evaluations.set(token.id, evaluations);
	}

	async #propose(token: TrainableToken, input: {
		readonly objective: string;
		readonly constraints: readonly string[];
		readonly engine?: TrainingEngine | EngineFunction;
		readonly signal?: AbortSignal;
	}): Promise<CandidatePatch> {
		const target = findTrainable(token.id, this.#settings.source);
		const records = await this.records(token);
		return withPolicy(
			this.#settings.resilience?.propose,
			"engine.propose",
			(signal) => this.#engineFor(input.engine).propose(
				{
					trainableId: token.id,
					objective: input.objective,
					target,
					records,
					evaluations: this.#evaluations.get(token.id) ?? [],
					...(input.constraints.length === 0 ? {} : { constraints: input.constraints }),
				},
				{
					variables: this.#variables,
					...optional("secrets", this.#settings.secrets),
					...optional("model", this.#settings.model),
					...optional("signal", signal),
				},
			),
			input.signal,
		);
	}

	async #activate(run: TrainingRun): Promise<Activation> {
		const { candidate, decision } = run.final;
		if (!decision.promote) {
			throw new PromotionRejectedError(candidate.id, decision);
		}
		const promote = this.#settings.promote ?? defaultProviders.promote;
		if (!promote) {
			throw new PromotionApplierNotConfiguredError();
		}
		const executor = this.#settings.executor ?? defaultProviders.executor;
		const applied = await promote(candidate, decision, executor);
		return Object.freeze({ run, rollback: () => applied.rollback() });
	}

	async flush(): Promise<void> {
		await Promise.all([...this.#pending]);
	}

	capture<This, Args extends unknown[], Result>(
		trainable: TrainableIdentity,
		methodName: string,
		thisValue: This,
		method: (this: This, ...args: Args) => Result,
		args: Args,
	): Result {
		return this.invoke(thisValue, method, args, toTrainableToken(trainable), methodName);
	}

	invoke<This, Args extends unknown[], Result>(
		thisValue: This,
		method: (this: This, ...args: Args) => Result,
		args: Args,
		token: TrainableToken,
		name: string,
	): Result {
		const tracing = this.#settings.tracing ?? {};
		if (tracing.enabled === false) {
			return this.#execute(thisValue, method, args, token, name);
		}
		const attributes: Attributes = {
			...tracing.attributes,
			[SemanticConventions.OPENINFERENCE_SPAN_KIND]: tracing.kind ?? OpenInferenceSpanKind.CHAIN,
			[trainableAttribute]: token.id,
		};
		return this.#tracer.startActiveSpan(name, { attributes }, (span) =>
			this.#execute(thisValue, method, args, token, name, span));
	}

	#execute<This, Args extends unknown[], Result>(
		thisValue: This,
		method: (this: This, ...args: Args) => Result,
		args: Args,
		token: TrainableToken,
		name: string,
		span?: Span,
	): Result {
		const startedAt = new Date();
		const runId = randomUUID();
		const execution = { args, name, token, runId, startedAt, ...optional("span", span) };
		let result: Result;
		try {
			result = method.apply(thisValue, args);
		} catch (error) {
			this.#finish({ ...execution, error });
			throw error;
		}
		if (isPromise(result)) {
			return result.then(
				(value) => {
					this.#finish({ ...execution, result: value });
					return value;
				},
				(error) => {
					this.#finish({ ...execution, error });
					throw error;
				},
			) as Result;
		}
		this.#finish({ ...execution, result });
		return result;
	}

	#finish({ span, result, error, args, name, token, runId, startedAt }: {
		span?: Span;
		result?: unknown;
		error?: unknown;
		args: readonly unknown[];
		name: string;
		token: TrainableToken;
		runId: string;
		startedAt: Date;
	}): void {
		const endedAt = new Date();
		if (span) {
			if (error === undefined) span.setStatus({ code: SpanStatusCode.OK });
			else {
				span.recordException(error instanceof Error ? error : String(error));
				span.setStatus({ code: SpanStatusCode.ERROR });
			}
			span.end();
		}
		const capture = this.#settings.capture ?? {};
		if (capture.enabled === false) return;
		attempt(() => {
			const spanContext = span?.spanContext();
			const input = capture.mapInput ? capture.mapInput(args, token) : args;
			const output = error === undefined
				? (capture.mapOutput ? capture.mapOutput(result, token) : result)
				: errorMessage(error);
			const record: TrainingRecord = {
				id: randomUUID(),
				runId,
				trainableId: token.id,
				method: name,
				succeeded: error === undefined,
				recordedAt: endedAt.toISOString(),
				trace: buildTraceFromMessages({
					input: [{ role: "user", content: this.#serialize(input) }],
					output: [{ role: "assistant", content: this.#serialize(output) }],
					startTime: startedAt.toISOString(),
					endTime: endedAt.toISOString(),
					durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
					provider: "ts-autocode",
					target: token.id,
					metadata: {
						runId,
						trainableId: token.id,
						...(spanContext === undefined ? {} : { traceId: spanContext.traceId, spanId: spanContext.spanId }),
					},
					...(error === undefined ? {} : { error: errorMessage(error) }),
				}),
			};
			this.#enqueue(() => this.#store.append(record));
			if (error === undefined) this.#maybeEvolve(token);
		}, this.#report("capture"));
	}

	#report(phase: ErrorPhase): (error: unknown) => void {
		return (error) => {
			if (phase === "capture") this.#emit({ type: "capture.failed", phase, error });
			else if (phase === "store") this.#emit({ type: "store.failed", phase, error });
			else this.#settings.onError?.(error, phase);
		};
	}

	#emit(event: TrainingEvent): void {
		attempt(() => this.#settings.onEvent?.(event), () => undefined);
		if ("error" in event) {
			attempt(() => this.#settings.onError?.(event.error, event.phase), () => undefined);
		}
	}

	#serialize(value: unknown): string {
		return (this.#settings.capture?.serialize ?? defaultSerialize)(value);
	}

	#enqueue(write: () => Promise<void>): void {
		const pending = withPolicy(this.#settings.resilience?.store, "store.append", write)
			.catch(this.#report("store"))
			.finally(() => {
				this.#pending.delete(pending);
			});
		this.#pending.add(pending);
	}
}

let configuredTraining: TrainingRuntime | undefined;
let configuredSettings: TrainingSettings = {};

export interface ConfigureOptions {
	readonly merge?: boolean;
}

export function configureTraining(settings: TrainingSettings = {}, options: ConfigureOptions = {}): Training {
	configuredSettings = options.merge ? { ...configuredSettings, ...settings } : settings;
	configuredTraining = new TrainingRuntime(configuredSettings);
	return configuredTraining;
}

export function createTrainingRuntime(settings: TrainingSettings = {}): Training {
	return new TrainingRuntime(settings);
}

export function resetTraining(): void {
	configuredTraining = undefined;
	configuredSettings = {};
}

export interface TrainingProviders {
	readonly engine?: () => TrainingEngine;
	readonly executor?: ImplementationExecutor;
	readonly loop?: TrainingLoop;
	readonly evolution?: EvolutionSettings;
	readonly promote?: Promoter;
}

let defaultProviders: TrainingProviders = {};

export function provideTrainingDefaults(providers: TrainingProviders): void {
	defaultProviders = { ...defaultProviders, ...providers };
}

export const training: Training = Object.freeze<Training>({
	records: (identity) => runtime().records(identity),
	evaluate: (identity, config) => runtime().evaluate(identity, config),
	train: (first: TrainInput | TrainableIdentity, rest?: Omit<TrainInput, "trainable">) =>
		runtime().train(first as TrainInput, rest),
	capture: (trainable, methodName, thisValue, method, args) =>
		runtime().capture(trainable, methodName, thisValue, method, args),
	flush: () => runtime().flush(),
});

export function captureTrainable<This, Args extends unknown[], Result>(
	id: string,
	methodName: string,
	thisValue: This,
	method: (this: This, ...args: Args) => Result,
	args: Args,
): Result {
	return runtime().invoke(thisValue, method, args, defineTrainable(id), methodName);
}

function runtime(): TrainingRuntime {
	return configuredTraining ??= new TrainingRuntime({});
}

function activationReadiness(run: TrainingRun, hasApplier: () => boolean): ActivationReadiness {
	const { decision } = run.final;
	if (decision.promote && hasApplier()) return Object.freeze({ ready: true as const });
	const failures = decision.promote
		? [new PromotionApplierNotConfiguredError().message]
		: decision.failures;
	return Object.freeze({ ready: false as const, outcome: run.outcome, failures: Object.freeze([...failures]) });
}

function isPromise<T>(value: T): value is T & Promise<Awaited<T>> {
	return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}

function defaultSerialize(value: unknown): string {
	if (typeof value === "string") return value;
	return attempt(() => JSON.stringify(value) ?? String(value), () => String(value));
}

export function evaluationArgs(input: string): readonly unknown[] {
	return attempt(() => {
		const parsed = JSON.parse(input) as unknown;
		return Array.isArray(parsed) ? parsed : [parsed];
	}, () => [input]);
}

function casesEvaluation(
	pairs: ReadonlyArray<readonly [unknown, unknown]>,
	evaluation: TrainInput["evaluation"],
): EvalConfig {
	const text = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value);
	const byInput = new Map<string, EvalTestInput>();
	pairs.forEach(([input, expected], index) => {
		const value = text(input);
		const expectedOutput = text(expected);
		byInput.set(value, {
			id: `case-${index + 1}`,
			input: value,
			expectedOutput,
			assert: [{ type: "equals", value: expectedOutput }],
		});
	});
	const tests = [...byInput.values()];
	const expected = new Map(tests.map((test) => [String(test.input), test.expectedOutput ?? ""]));
	return {
		...evaluation,
		tests,
		task: (value) => {
			const output = expected.get(value);
			if (output === undefined) throw new TraceNotFoundError(value);
			return output;
		},
	};
}

function liveEvalCases(records: readonly TrainingRecord[]): readonly EvalTestInput[] {
	const examples = new Map<string, EvalTestInput>();
	for (const record of [...records].sort((left, right) => left.recordedAt.localeCompare(right.recordedAt))) {
		if (!record.succeeded) continue;
		const input = record.trace.messages.find((message) => message.role === "user");
		const output = record.trace.messages.findLast((message) => message.role === "assistant");
		if (!input || !output) continue;
		const value = getTextContent(input.content);
		const expectedOutput = getTextContent(output.content);
		examples.set(value, {
			id: `trace-${record.id}`,
			input: value,
			expectedOutput,
			assert: [{ type: "equals", value: expectedOutput }],
		});
	}
	return [...examples.values()];
}

function promotionRubric(input: TrainInput): string {
	const options = resolved(input);
	return [
		"Candidate must pass source conformance checks.",
		`Minimum evaluation score: ${options.minScore ?? defaultMinScore}.`,
		`Minimum evaluation pass rate: ${options.minPassRate ?? defaultMinPassRate}.`,
		input.policy === undefined ? "No additional promotion policy." : "Candidate must pass the configured promotion policy.",
	].join(" ");
}

