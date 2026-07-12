import { randomUUID } from "node:crypto";

import { buildTraceFromMessages, getTextContent, type EvalConfig, type EvalTestInput } from "@agentv/core";
import { OpenInferenceSpanKind, SemanticConventions } from "@arizeai/openinference-semantic-conventions";
import { SpanStatusCode, trace, type Attributes, type Span, type Tracer } from "@opentelemetry/api";

import {
	CandidateEngine,
	type BoundEvaluation,
	type CandidatePatch,
	type ImplementationExecutor,
	type SecretProvider,
	type TrainingEngine,
} from "./engine.js";
import { evaluateTrainable, type TrainableEvalRun } from "./evaluation.js";
import { sequentialLoop, type TrainingLoop, type TrainingRound } from "./loop.js";
import { evaluatePromotionGate, type PromotionDecision } from "./promotion.js";
import { createMemoryTrainingStore, type TrainingRecord, type TrainingStore } from "./records.js";
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

/** Background code evolution driven by captured traffic; disabled unless enabled here
 * or via `ts-autocode/register`. Rewrites still pass the full gate before applying. */
export interface EvolutionSettings {
	readonly enabled?: boolean;
	readonly minTraces?: number;
	readonly objective?: string;
	readonly evaluation?: Omit<EvalConfig, "specFile" | "target" | "task" | "tests">;
	readonly onEvolved?: (activation: Activation) => void;
}

/** What background evolution uses when `EvolutionSettings.minTraces` is unset. */
export const defaultEvolution: Required<Pick<EvolutionSettings, "minTraces">> = Object.freeze({
	minTraces: 3,
});

/** Optimization goal when `TrainInput.objective` is unset. */
export const defaultObjective = "Preserve behavior demonstrated by the evaluation cases";

/** Where run artifacts and eval output land when neither `EvalConfig.outputDir`
 * nor `TrainingSettings.outputDir` names a directory. */
export const defaultOutputDir = ".agentv";

export interface TrainingSettings {
	readonly engine?: TrainingEngine;
	readonly executor?: ImplementationExecutor;
	readonly loop?: TrainingLoop;
	readonly evolution?: EvolutionSettings;
	/** Default directory for run artifacts and eval output; a run's
	 * `EvalConfig.outputDir` still overrides it. */
	readonly outputDir?: string;
	readonly source?: SourceSettings;
	readonly store?: TrainingStore;
	readonly secrets?: SecretProvider;
	readonly variables?: Readonly<Record<string, string>>;
	readonly capture?: CaptureSettings;
	readonly tracing?: TracingSettings;
	readonly onError?: (error: unknown, phase: "capture" | "store" | "evolve") => void;
}

export interface TrainInput {
	readonly trainable: TrainableIdentity;
	/** Optimization goal; defaults to preserving the evaluated behavior. */
	readonly objective?: string;
	/** AgentV evaluation. When `tests` are omitted, distinct successful captured
	 * runtime traces are replayed as equality eval cases instead. */
	readonly evaluation?: EvalConfig;
	/** Minimum distinct successful traces required before training from replayed
	 * captures; ignored when explicit `evaluation.tests` are given. */
	readonly minTraces?: number;
	readonly constraints?: readonly string[];
	readonly engine?: TrainingEngine;
	readonly signal?: AbortSignal;
	readonly maxRounds?: number;
	readonly minScore?: number;
	readonly minPassRate?: number;
	readonly policy?: (candidate: CandidatePatch) => boolean | Promise<boolean>;
}

export interface TrainingRun {
	readonly outcome: "ready" | "stalled" | "exhausted";
	readonly baseline: TrainableEvalRun;
	readonly rounds: readonly TrainingRound[];
	readonly final: TrainingRound;
	/** Apply the final candidate through the wired promotion applier. Throws
	 * unless the candidate passed the promotion gate. */
	activate(): Promise<Activation>;
}

/** An applied training result. */
export interface Activation {
	readonly run: TrainingRun;
	/** Undo the activation: the wired applier restores whatever it changed. */
	rollback(): Promise<void>;
}

/** An applied promotion and how to undo it exactly. */
export interface AppliedPromotion {
	rollback(): Promise<void>;
}

/** Applies a gate-approved candidate — to its source artifact and, where the
 * wired provider supports it, the running process. How is the provider's
 * concern; training only requires that the application be undoable. The
 * resolved executor is passed along for providers that run candidates live. */
export type PromotionApplier = (
	candidate: CandidatePatch,
	decision: PromotionDecision,
	executor?: ImplementationExecutor,
) => Promise<AppliedPromotion>;

type CandidateEvalConfig = Omit<EvalConfig, "task"> & { readonly signal?: AbortSignal };

export interface Training {
	records(trainable?: TrainableIdentity): Promise<readonly TrainingRecord[]>;
	evaluate(trainable: TrainableIdentity, config: EvalConfig): Promise<TrainableEvalRun>;
	train(input: TrainInput): Promise<TrainingRun>;
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
		this.#store = settings.store ?? createMemoryTrainingStore();
		this.#tracer = settings.tracing?.tracer ?? trace.getTracer(tracerName);
	}

	#engineFor(override?: TrainingEngine): CandidateEngine {
		if (override) return new CandidateEngine(override);
		if (!this.#engine) {
			const strategy = this.#settings.engine ?? defaultProviders.engine?.();
			if (!strategy) {
				throw new Error('no training engine is configured; import "ts-autocode" for the Ax default or set TrainingSettings.engine');
			}
			this.#engine = new CandidateEngine(strategy);
		}
		return this.#engine;
	}

	#executorOrThrow(): ImplementationExecutor {
		const executor = this.#settings.executor ?? defaultProviders.executor;
		if (!executor) {
			throw new Error('candidate execution requires an executor; import "ts-autocode" or set TrainingSettings.executor');
		}
		return executor;
	}

	#maybeEvolve(token: TrainableToken): void {
		const evolution = this.#settings.evolution ?? defaultProviders.evolution;
		if (evolution?.enabled !== true) return;
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
			if (successes < state.attempted + minTraces) return;
			state.attempted = successes;
			const run = await this.train({
				trainable: token,
				minTraces,
				...(evolution.objective === undefined ? {} : { objective: evolution.objective }),
				...(evolution.evaluation === undefined ? {} : { evaluation: evolution.evaluation }),
			});
			if (run.outcome !== "ready") {
				throw new Error(`background training did not produce a promotable candidate: ${run.outcome}`);
			}
			evolution.onEvolved?.(await run.activate());
		})()
			.catch((error) => this.#settings.onError?.(error, "evolve"))
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
		const { signal, ...evaluation } = config;
		signal?.throwIfAborted();
		const evaluated = await evaluateTrainable(token, {
			...evaluation,
			task: async (input) => {
				const output = await execute(
					candidate.target,
					candidate.implementation,
					evaluationArgs(input),
					signal === undefined ? {} : { signal },
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

	async train(input: TrainInput): Promise<TrainingRun> {
		const token = toTrainableToken(input.trainable);
		const objective = input.objective ?? defaultObjective;
		const evaluation = input.evaluation?.tests ? input.evaluation : await this.#replayEvaluation(token, input);
		const { task: _task, outputDir = this.#settings.outputDir ?? defaultOutputDir, ...candidateEvaluation } = evaluation;
		const baseline = await this.evaluate(token, { ...evaluation, outputDir });
		const loop = this.#settings.loop ?? defaultProviders.loop ?? sequentialLoop;
		const result = await loop({
			trainableId: token.id,
			objective,
			rubric: promotionRubric(input),
			outputDir,
			...(input.maxRounds === undefined ? {} : { maxRounds: input.maxRounds }),
			...(input.signal === undefined ? {} : { signal: input.signal }),
			propose: ({ feedback, signal }) => this.#propose(token, {
				objective,
				constraints: [
					...(input.constraints ?? []),
					...feedback.map((failure) => `Previous candidate rejection: ${failure}`),
				],
				...(input.engine === undefined ? {} : { engine: input.engine }),
				...(signal === undefined ? {} : { signal }),
			}),
			review: async (candidate, { label, signal }) => {
				const verification = await this.#evaluateCandidate(candidate, {
					...candidateEvaluation,
					...(signal === undefined ? {} : { signal }),
					outputDir: `${outputDir}/${label}`,
				});
				const decision = await evaluatePromotionGate({
					candidate,
					evaluations: verification.evaluations,
					// The engine already validated the candidate source.
					conformance: true,
					...(input.minScore === undefined ? {} : { minScore: input.minScore }),
					...(input.minPassRate === undefined ? {} : { minPassRate: input.minPassRate }),
					...(input.policy === undefined ? {} : { policy: input.policy }),
				});
				return { verification, decision };
			},
		});
		const final = result.rounds.at(-1);
		if (!final) throw new Error(`training loop returned no rounds: ${result.outcome}`);
		const run: TrainingRun = Object.freeze({
			outcome: result.outcome,
			baseline,
			rounds: Object.freeze([...result.rounds]),
			final,
			activate: () => this.#activate(run),
		});
		return run;
	}

	/** Training from live traffic is the same operation as training from explicit
	 * tests: distinct successful captured traces become equality eval cases. */
	async #replayEvaluation(token: TrainableToken, input: TrainInput): Promise<EvalConfig> {
		const minTraces = input.minTraces ?? 1;
		if (!Number.isInteger(minTraces) || minTraces < 1) {
			throw new TypeError("minTraces must be a positive integer");
		}
		const tests = liveEvalCases(await this.records(token));
		if (tests.length < minTraces) {
			throw new Error(`training from captured traffic requires ${minTraces} distinct successful runtime trace${minTraces === 1 ? "" : "s"}; found ${tests.length}`);
		}
		const expected = new Map(tests.map((test) => [String(test.input), test.expectedOutput ?? ""]));
		return {
			...input.evaluation,
			tests,
			task: (value) => {
				const output = expected.get(value);
				if (output === undefined) throw new Error(`live trace was not found for eval input: ${value}`);
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
		readonly engine?: TrainingEngine;
		readonly signal?: AbortSignal;
	}): Promise<CandidatePatch> {
		const target = findTrainable(token.id, this.#settings.source);
		const records = await this.records(token);
		return this.#engineFor(input.engine).propose(
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
				...(this.#settings.secrets === undefined ? {} : { secrets: this.#settings.secrets }),
				...(input.signal === undefined ? {} : { signal: input.signal }),
			},
		);
	}

	async #activate(run: TrainingRun): Promise<Activation> {
		const { candidate, decision } = run.final;
		if (!decision.promote) {
			throw new Error(`candidate has not passed the promotion gate: ${candidate.id}`);
		}
		const promote = defaultProviders.promote;
		if (!promote) {
			throw new Error('activation requires a promotion applier; import "ts-autocode" for the default or set TrainingProviders.promote');
		}
		const executor = this.#settings.executor ?? defaultProviders.executor;
		const applied = await promote(candidate, decision, executor);
		return Object.freeze({ run, rollback: () => applied.rollback() });
	}

	async flush(): Promise<void> {
		await Promise.all([...this.#pending]);
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
		const execution = { args, name, token, runId, startedAt, ...(span === undefined ? {} : { span }) };
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
		try {
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
			this.#enqueue(this.#store.append(record));
			if (error === undefined) this.#maybeEvolve(token);
		} catch (captureError) {
			this.#settings.onError?.(captureError, "capture");
		}
	}

	#serialize(value: unknown): string {
		return (this.#settings.capture?.serialize ?? defaultSerialize)(value);
	}

	#enqueue(write: Promise<void>): void {
		const pending = write.catch((error) => this.#settings.onError?.(error, "store")).finally(() => {
			this.#pending.delete(pending);
		});
		this.#pending.add(pending);
	}
}

let configuredTraining: TrainingRuntime | undefined;

export function configureTraining(settings: TrainingSettings = {}): Training {
	configuredTraining = new TrainingRuntime(settings);
	return configuredTraining;
}

export interface TrainingProviders {
	readonly engine?: () => TrainingEngine;
	readonly executor?: ImplementationExecutor;
	readonly loop?: TrainingLoop;
	readonly evolution?: EvolutionSettings;
	readonly promote?: PromotionApplier;
}

let defaultProviders: TrainingProviders = {};

/** Provider packages call this to supply lazy fallbacks (ts-autocode wires the
 * Ax engine, its sandbox executor, the governed harness loop, and a promotion
 * applier) without this package depending on any provider. Explicit settings
 * win. */
export function provideTrainingDefaults(providers: TrainingProviders): void {
	defaultProviders = { ...defaultProviders, ...providers };
}

/** Default runtime: the "use training" directive is the only required marker.
 * `configureTraining()` is optional and only overrides settings; each call
 * delegates to the current runtime so later configuration still applies. */
export const training: Training = Object.freeze<Training>({
	records: (identity) => runtime().records(identity),
	evaluate: (identity, config) => runtime().evaluate(identity, config),
	train: (input) => runtime().train(input),
	flush: () => runtime().flush(),
});

/** Routes one call of a marked trainable through runtime capture: the call is
 * recorded against `id`, spans are emitted per the tracing settings, and
 * background evolution may be scheduled. Instrumentation wiring (for example
 * ts-autocode's rewrite integration) calls this from whatever interception
 * mechanism it owns; this package has no knowledge of that mechanism. */
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

function isPromise<T>(value: T): value is T & Promise<Awaited<T>> {
	return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}

function defaultSerialize(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function evaluationArgs(input: string): readonly unknown[] {
	try {
		const parsed = JSON.parse(input) as unknown;
		return Array.isArray(parsed) ? parsed : [parsed];
	} catch {
		return [input];
	}
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
	return [
		"Candidate must pass source conformance checks.",
		`Minimum evaluation score: ${input.minScore ?? "evaluation default"}.`,
		`Minimum evaluation pass rate: ${input.minPassRate ?? 1}.`,
		input.policy === undefined ? "No additional promotion policy." : "Candidate must pass the configured promotion policy.",
	].join(" ");
}

