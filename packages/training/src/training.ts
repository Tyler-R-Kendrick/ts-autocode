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
const traceMinimum = z.number().int().positive("minTraces must be a positive integer");
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

/** Background code evolution driven by captured traffic; disabled unless enabled here
 * or via `ts-autocode/register`. Rewrites still pass the full gate before applying. */
export interface EvolutionSettings {
	/** Turn background evolution on. Unlike `capture.enabled` and
	 * `tracing.enabled`, which are opt-*out* recording switches, this is
	 * opt-*in*: it rewrites your source files. The name says so. */
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

/** What background evolution uses when `EvolutionSettings.minTraces` is unset. */
export const defaultEvolution: Required<Pick<EvolutionSettings, "minTraces">> = Object.freeze({
	minTraces: 3,
});

/** Optimization goal when `TrainInput.objective` is unset. */
export const defaultObjective = "Preserve behavior demonstrated by the evaluation cases";

/** Where run artifacts and eval output land when neither `EvalConfig.outputDir`
 * nor `TrainingSettings.outputDir` names a directory. */
export const defaultOutputDir = ".agentv";

/** How proposed candidate bodies are run during verification. Distinct from
 * `resilience.evaluate`, which bounds the whole attempt and may retry it: this
 * is the executor's own per-run limit. */
export interface ExecutionSettings {
	readonly timeoutMs?: number;
	/** How an eval case's string input becomes the trainable's argument list.
	 *
	 * AgentV evaluation is string-in, string-out, so by default an input is
	 * `JSON.parse`d and a resulting array is spread as arguments. That guess is
	 * lossy: a function legitimately taking the single string `"[1,2]"`
	 * receives two numbers instead. Set this when your trainable's arguments
	 * are not what the guess produces — `(input) => [input]` passes the raw
	 * string through unchanged. */
	readonly decodeArgs?: (input: string) => readonly unknown[];
}

export interface TrainingSettings {
	/** The optimizer. A bare `(request, context) => body` function works; the
	 * `{ id, optimize }` object form is for engines with a published identity. */
	readonly engine?: TrainingEngine | EngineFunction;
	readonly executor?: ImplementationExecutor;
	/** Options handed to the executor on every candidate run. */
	readonly execution?: ExecutionSettings;
	readonly loop?: TrainingLoop;
	/** Applies a gate-approved candidate. Every other seam resolves from these
	 * settings before falling back to {@link provideTrainingDefaults}; this one
	 * did not exist, so an applier could only ever be registered process-wide.
	 * That left {@link createTrainingRuntime} sharing one applier between
	 * runtimes -- the component that writes generated code into a source file. */
	readonly promote?: Promoter;
	readonly evolution?: EvolutionSettings;
	/** Default directory for run artifacts and eval output; a run's
	 * `EvalConfig.outputDir` still overrides it. */
	readonly outputDir?: string;
	readonly source?: SourceSettings;
	readonly store?: TrainingStore;
	readonly secrets?: SecretProvider;
	/** Which model the configured engine should use. The default Ax engine
	 * reads it, so choosing a provider does not mean replacing the engine. */
	readonly model?: ModelSelection;
	readonly variables?: Readonly<Record<string, string>>;
	readonly capture?: CaptureSettings;
	readonly tracing?: TracingSettings;
	/** Timeout/retry policies for named runtime operations; operations without
	 * a policy behave exactly as before. */
	readonly resilience?: ResilienceSettings;
	/** Every background event, including the failures `onError` reports. There
	 * was previously no way to observe an evolution starting or being skipped. */
	readonly onEvent?: (event: TrainingEvent) => void;
	/** @deprecated Use {@link TrainingSettings.onEvent}, which reports the same
	 * failures alongside evolution lifecycle events. Still supported: it is
	 * called for every event carrying an `error`. */
	readonly onError?: (error: unknown, phase: ErrorPhase) => void;
}

/** Where a background failure was routed from: trace capture, store writes,
 * or background evolution. These never fail the traced call itself. */
export type ErrorPhase = "capture" | "store" | "evolve";

/** Everything the runtime reports about work it does in the background. The
 * failure arms carry the same `(error, phase)` pair `onError` received, so the
 * older callback is a projection of this one rather than a parallel channel. */
export type TrainingEvent =
	| Readonly<{ type: "capture.failed"; phase: "capture"; trainable?: TrainableToken; error: unknown }>
	| Readonly<{ type: "store.failed"; phase: "store"; error: unknown }>
	| Readonly<{ type: "evolution.started"; phase: "evolve"; trainable: TrainableToken; traces: number }>
	| Readonly<{ type: "evolution.applied"; phase: "evolve"; trainable: TrainableToken; activation: Activation }>
	| Readonly<{ type: "evolution.skipped"; phase: "evolve"; trainable: TrainableToken; traces: number; required: number }>
	| Readonly<{ type: "evolution.failed"; phase: "evolve"; trainable: TrainableToken; error: unknown }>;

/** How many rounds a run explores, and how wide each one is. */
export interface RoundSettings {
	readonly max?: number;
	/** Maximum candidates proposed and reviewed concurrently per round. The
	 * default governed harness loop reviews one per round and refuses more;
	 * `sequentialLoop` supports it. */
	readonly fanOut?: number;
}

/** What a candidate must clear to be promoted. `policy` was always a
 * {@link PromotionGate} in disguise -- the gate evaluator wrapped it into one --
 * so a single `gates` list now expresses both. */
export interface PromotionSettings {
	readonly minScore?: number;
	readonly minPassRate?: number;
	/** Extra gates run after the standard {@link defaultPromotionGates} set.
	 * Extension adds rules; it cannot waive the standard invariants. */
	readonly gates?: readonly PromotionGate[];
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
	readonly engine?: TrainingEngine | EngineFunction;
	readonly signal?: AbortSignal;
	/** The shortest way to state evaluation: `[input, expected]` pairs. Each
	 * becomes an equality eval case, with non-strings JSON-encoded the same way
	 * outputs are compared, and the baseline task is a lookup over the pairs --
	 * exactly how replayed live traffic is evaluated. Repeated inputs keep the
	 * last expected value. `evaluation.tests`, when present, wins; `evaluation`
	 * still carries options like `outputDir` alongside `cases`. */
	readonly cases?: ReadonlyArray<readonly [input: unknown, expected: unknown]>;
	/** Round budget and width. */
	readonly rounds?: RoundSettings;
	/** Promotion thresholds and extra gates. */
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

/** Collapses the grouped and flat forms of one input into the values the
 * runtime uses. The grouped form wins; both are accepted for one release. */
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

/** Whether a run's final candidate can be applied, and if not, why. `outcome`
 * already distinguishes `"stalled"` from `"exhausted"`, so a caller should not
 * have to provoke an exception to learn which happened. */
export type ActivationReadiness =
	| Readonly<{ ready: true }>
	| Readonly<{ ready: false; outcome: TrainingRun["outcome"]; failures: readonly string[] }>;

export interface TrainingRun {
	readonly outcome: "ready" | "stalled" | "exhausted";
	readonly baseline: TrainableEvalRun;
	readonly rounds: readonly TrainingRound[];
	readonly final: TrainingRound;
	/** Whether {@link TrainingRun.activate} would succeed, without throwing.
	 * Prefer this over a speculative `try`/`catch` around `activate()`. */
	canActivate(): ActivationReadiness;
	/** Apply the final candidate through the wired promotion applier. Throws
	 * {@link PromotionRejectedError} unless the candidate passed the promotion
	 * gate; {@link TrainingRun.canActivate} reports the same thing without
	 * throwing. */
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
export type Promoter = (
	candidate: CandidatePatch,
	decision: PromotionDecision,
	executor?: ImplementationExecutor,
) => Promise<AppliedPromotion>;

/** @deprecated Renamed to {@link Promoter} — the agent noun its four sibling
 * seams already use (engine, executor, loop, store). Structurally identical;
 * existing implementations need no change. */
export type PromotionApplier = Promoter;

type CandidateEvalConfig = Omit<EvalConfig, "task"> & { readonly signal?: AbortSignal };

export interface Training {
	records(trainable?: TrainableIdentity): Promise<readonly TrainingRecord[]>;
	evaluate(trainable: TrainableIdentity, config: EvalConfig): Promise<TrainableEvalRun>;
	/** Train the trainable a symbol keys: `training.train(route)`, the same
	 * symbol `@trainable(route)` put on the code. Options ride along as the
	 * second argument; the object form remains for spelling everything out. */
	train(trainable: TrainableIdentity, input?: Omit<TrainInput, "trainable">): Promise<TrainingRun>;
	train(input: TrainInput): Promise<TrainingRun>;
	/** Route one call of a marked trainable through *this* runtime's capture.
	 *
	 * {@link captureTrainable} does the same thing for the process-wide runtime,
	 * and is what installed instrumentation calls. A runtime built with
	 * {@link createTrainingRuntime} is not reachable that way -- it registers
	 * nothing globally, by design -- so without this an isolated runtime could
	 * train and evaluate but never capture, which is half a runtime. */
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
					// The engine already validated the candidate source.
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
			canActivate: () => activationReadiness(run),
			activate: () => this.#activate(run),
		});
		return run;
	}

	/** Training from live traffic is the same operation as training from explicit
	 * tests: distinct successful captured traces become equality eval cases. */
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

	/** The boundary sink for background failures: every capture, store, and
	 * evolution error funnels through here into the settings callbacks. */
	#report(phase: ErrorPhase): (error: unknown) => void {
		return (error) => {
			if (phase === "capture") this.#emit({ type: "capture.failed", phase, error });
			else if (phase === "store") this.#emit({ type: "store.failed", phase, error });
			else this.#settings.onError?.(error, phase);
		};
	}

	/** The single sink for background events. `onError` is a projection of it:
	 * every arm carrying an `error` is forwarded to the older callback with the
	 * phase it always received, so both can be configured at once without a
	 * failure being reported twice to the same handler. */
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
	/** Merge into the current settings instead of replacing them. Off by
	 * default: `configureTraining` has always replaced, and silently carrying
	 * settings between unrelated calls is worse than the surprise it fixes. */
	readonly merge?: boolean;
}

/** Configure the process-wide runtime that the exported `training` const
 * delegates to. Replaces the current settings unless `merge` is set; pass
 * `{ merge: true }` to layer onto whatever is already configured.
 *
 * For an isolated runtime that touches no global state — a test, or a host
 * serving several tenants — use {@link createTrainingRuntime}. */
export function configureTraining(settings: TrainingSettings = {}, options: ConfigureOptions = {}): Training {
	configuredSettings = options.merge ? { ...configuredSettings, ...settings } : settings;
	configuredTraining = new TrainingRuntime(configuredSettings);
	return configuredTraining;
}

/** Build a runtime that owns its own settings, store and evolution state, and
 * registers nothing globally. The exported `training` const is unaffected, so
 * several of these can run side by side. Provider defaults registered with
 * {@link provideTrainingDefaults} still apply, so `import "ts-autocode"` gives
 * this the Ax engine and the governed loop exactly as it gives them to the
 * shared runtime. */
export function createTrainingRuntime(settings: TrainingSettings = {}): Training {
	return new TrainingRuntime(settings);
}

/** Discard the process-wide runtime and its settings, restoring the state of a
 * fresh import. Intended for tests: without it, one test's `configureTraining`
 * call is visible to every later one. */
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
	capture: (trainable, methodName, thisValue, method, args) =>
		runtime().capture(trainable, methodName, thisValue, method, args),
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

/** Why a run's final candidate may not be applied. Mirrors exactly what
 * `activate()` enforces, so the two can never disagree. */
function activationReadiness(run: TrainingRun): ActivationReadiness {
	const { decision } = run.final;
	if (decision.promote) return Object.freeze({ ready: true as const });
	return Object.freeze({ ready: false as const, outcome: run.outcome, failures: decision.failures });
}

function isPromise<T>(value: T): value is T & Promise<Awaited<T>> {
	return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}

function defaultSerialize(value: unknown): string {
	if (typeof value === "string") return value;
	return attempt(() => JSON.stringify(value) ?? String(value), () => String(value));
}

/** The default {@link ExecutionSettings.decodeArgs}: parse the eval input as
 * JSON and spread an array as the argument list, falling back to the raw string.
 * Ambiguous by nature — a trainable taking the literal string `"[1,2]"` gets
 * two numbers — which is why it is replaceable. */
export function evaluationArgs(input: string): readonly unknown[] {
	return attempt(() => {
		const parsed = JSON.parse(input) as unknown;
		return Array.isArray(parsed) ? parsed : [parsed];
	}, () => [input]);
}

/** `[input, expected]` pairs as an eval config: equality cases plus the same
 * lookup task replayed traffic uses, so `cases` and live replay are one
 * evaluation semantics with two sources. */
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
		// The judge reads this verbatim, so it must carry the resolved numbers a
		// candidate is actually held to -- never a placeholder.
		`Minimum evaluation score: ${options.minScore ?? defaultMinScore}.`,
		`Minimum evaluation pass rate: ${options.minPassRate ?? defaultMinPassRate}.`,
		input.policy === undefined ? "No additional promotion policy." : "Candidate must pass the configured promotion policy.",
	].join(" ");
}

