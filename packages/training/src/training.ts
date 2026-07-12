import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildTraceFromMessages, getTextContent, type EvalConfig, type EvalTestInput } from "@agentv/core";
import { OpenInferenceSpanKind, SemanticConventions } from "@arizeai/openinference-semantic-conventions";
import { SpanStatusCode, trace, type Attributes, type Span, type Tracer } from "@opentelemetry/api";
import { defineTrainingHarness, WriteAheadAgentBus, type JudgeRequest } from "ts-autocode-harness";
import {
	annotateRewrite,
	configureRewrite,
	declaringContainer,
	dispatchRewrite,
	promoteCandidate,
	restoreImplementation,
	revertPromotion,
	swapImplementation,
	type PromotionResult,
	type PromotionSnapshot,
} from "ts-autocode-rewrite";

import {
	optimizeCandidate,
	type BoundEvaluation,
	type CandidatePatch,
	type ImplementationExecutor,
	type SecretProvider,
	type TrainingEngine,
} from "./engine.js";
import { evaluateTrainable, type TrainableEvalRun } from "./evaluation.js";
import { evaluatePromotionGate, type PromotionDecision } from "./promotion.js";
import { createMemoryTrainingStore, type TrainingRecord, type TrainingStore } from "./records.js";
import {
	discoverTrainables,
	findTrainable,
	type SourceSettings,
	type TrainableTarget,
} from "./source.js";
import {
	defineTrainable,
	toTrainableToken,
	trainableTokenFromSymbol,
	type TrainableIdentity,
	type TrainableToken,
} from "./token.js";

const trainableAttribute = "ts_autocode.trainable.id";

/** Training is one consumer of the generic rewrite engine; this is the marker it
 * configures. The `"use training"` directive is the shorthand that weaves a method. */
const trainingMarker = "use training";

// Register training's rewrite behavior once: every method woven under the
// "use training" marker routes through runtime capture, and `proceed` resolves
// the live (possibly hot-swapped) implementation so captures reflect what ran.
configureRewrite({
	marker: trainingMarker,
	intercept: ({ id, methodName, thisValue, args, proceed }) =>
		runtime().invoke(
			thisValue,
			function (this: unknown, ...next: unknown[]) { return proceed(...next); },
			[...args],
			defineTrainable(id),
			methodName,
		),
});

export interface CaptureSettings {
	readonly enabled?: boolean;
	readonly input?: boolean;
	readonly output?: boolean;
	readonly serialize?: (value: unknown) => string;
	readonly redact?: (value: unknown, field: "input" | "output") => unknown;
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
	readonly onEvolved?: (result: EvolveResult) => void;
}

export interface TrainingSettings {
	readonly engine?: TrainingEngine;
	readonly executor?: ImplementationExecutor;
	readonly evolution?: EvolutionSettings;
	readonly source?: SourceSettings;
	readonly store?: TrainingStore;
	readonly secrets?: SecretProvider;
	readonly variables?: Readonly<Record<string, string>>;
	readonly concurrency?: number;
	readonly capture?: CaptureSettings;
	readonly tracing?: TracingSettings;
	readonly idFactory?: () => string;
	readonly now?: () => Date;
	readonly onError?: (error: unknown, phase: "capture" | "store" | "evolve") => void;
}

export interface OptimizeInput {
	readonly trainable: TrainableIdentity;
	readonly objective: string;
	readonly target?: TrainableTarget;
	readonly constraints?: readonly string[];
	readonly evaluations?: readonly BoundEvaluation[];
	readonly engine?: TrainingEngine;
	readonly signal?: AbortSignal;
}

export type CandidateEvalConfig = Omit<EvalConfig, "task"> & { readonly signal?: AbortSignal };

export interface TrainInput {
	readonly trainable: TrainableIdentity;
	readonly objective: string;
	readonly evaluation: EvalConfig;
	readonly constraints?: readonly string[];
	readonly engine?: TrainingEngine;
	readonly signal?: AbortSignal;
	readonly maxRounds?: number;
	readonly minScore?: number;
	readonly minPassRate?: number;
	readonly conformance?: boolean;
	readonly policy?: (candidate: CandidatePatch) => boolean | Promise<boolean>;
}

export interface EvolveInput extends Omit<TrainInput, "evaluation"> {
	readonly evaluation?: Omit<EvalConfig, "specFile" | "target" | "task" | "tests">;
	readonly minTraces?: number;
}

export interface EvolveResult {
	readonly training: TrainingRun;
	readonly promotion: PromotionResult;
}

export interface TrainingRound {
	readonly round: number;
	readonly candidate: CandidatePatch;
	readonly verification: TrainableEvalRun;
	readonly decision: PromotionDecision;
}

export interface TrainingRun {
	readonly outcome: "ready" | "stalled" | "exhausted";
	readonly baseline: TrainableEvalRun;
	readonly rounds: readonly TrainingRound[];
	readonly final: TrainingRound;
}

type CandidateAssessment = Readonly<{
	verification: TrainableEvalRun;
	decision: PromotionDecision;
}>;

export interface Training {
	records(trainable?: TrainableIdentity): Promise<readonly TrainingRecord[]>;
	evaluate(trainable: TrainableIdentity, config: EvalConfig): Promise<TrainableEvalRun>;
	evaluateCandidate(candidate: CandidatePatch, config: CandidateEvalConfig): Promise<TrainableEvalRun>;
	train(input: TrainInput): Promise<TrainingRun>;
	evolve(input: EvolveInput): Promise<EvolveResult>;
	optimize(input: OptimizeInput): Promise<CandidatePatch>;
	optimizeAll(inputs: readonly OptimizeInput[]): Promise<readonly CandidatePatch[]>;
	promote(candidate: CandidatePatch, decision: PromotionDecision): Promise<PromotionResult>;
	revert(snapshot: PromotionSnapshot): Promise<void>;
	flush(): Promise<void>;
}

export type TrainableDecorator = <This, Args extends unknown[], Result>(
	method: (this: This, ...args: Args) => Result,
	context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
) => (this: This, ...args: Args) => Result;

class TrainingRuntime implements Training {
	readonly #settings: Required<Pick<TrainingSettings, "capture" | "concurrency" | "idFactory" | "now" | "source" | "tracing">> &
		Omit<TrainingSettings, "capture" | "concurrency" | "idFactory" | "now" | "source" | "tracing">;
	#engine: TrainingEngine | undefined;
	readonly #store: TrainingStore;
	readonly #tracer: Tracer;
	readonly #pending = new Set<Promise<void>>();
	readonly #evaluations = new Map<string, BoundEvaluation[]>();
	readonly #evolutionState = new Map<string, { running: boolean; queued: boolean; attempted: number }>();

	constructor(settings: TrainingSettings) {
		const concurrency = settings.concurrency ?? Number.POSITIVE_INFINITY;
		if (!(concurrency === Number.POSITIVE_INFINITY || (Number.isInteger(concurrency) && concurrency > 0))) {
			throw new TypeError("concurrency must be a positive integer");
		}
		this.#settings = {
			...settings,
			capture: settings.capture ?? {},
			concurrency,
			idFactory: settings.idFactory ?? randomUUID,
			now: settings.now ?? (() => new Date()),
			source: settings.source ?? {},
			tracing: settings.tracing ?? {},
			variables: Object.freeze({ ...settings.variables }),
		};
		this.#store = settings.store ?? createMemoryTrainingStore();
		this.#tracer = this.#settings.tracing.tracer ?? trace.getTracer("ts-autocode");
	}

	#engineFor(override?: TrainingEngine): TrainingEngine {
		if (override) return override;
		this.#engine ??= this.#settings.engine ?? defaultProviders.engine?.();
		if (!this.#engine) {
			throw new Error('no training engine is configured; import "ts-autocode" for the Ax default or set TrainingSettings.engine');
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
			const minTraces = Math.max(1, evolution.minTraces ?? 3);
			const successes = (await this.#store.list(token.id)).filter((record) => record.succeeded).length;
			if (successes < state.attempted + minTraces) return;
			state.attempted = successes;
			const result = await this.evolve({
				trainable: token,
				objective: evolution.objective ?? "Preserve behavior observed in successful runtime traces",
				minTraces,
				...(evolution.evaluation === undefined ? {} : { evaluation: evolution.evaluation }),
			});
			evolution.onEvolved?.(result);
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

	async evaluateCandidate(candidate: CandidatePatch, config: CandidateEvalConfig): Promise<TrainableEvalRun> {
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
		const baseline = await this.evaluate(input.trainable, input.evaluation);
		const { task: _task, outputDir = ".agentv", ...candidateEvaluation } = input.evaluation;
		let evaluations: readonly BoundEvaluation[] = baseline.evaluations;
		const assess = async (candidate: CandidatePatch, candidateOutputDir: string, signal?: AbortSignal): Promise<CandidateAssessment> => {
			const verification = await this.evaluateCandidate(candidate, {
				...candidateEvaluation,
				...(signal === undefined ? {} : { signal }),
				outputDir: candidateOutputDir,
			});
			const decision = await evaluatePromotionGate({
				candidate,
				evaluations: verification.evaluations,
				// The engine already validated the candidate; `conformance: false` waives the
				// requirement rather than reporting a failed check to the gate.
				conformance: true,
				...(input.minScore === undefined ? {} : { minScore: input.minScore }),
				...(input.minPassRate === undefined ? {} : { minPassRate: input.minPassRate }),
				...(input.policy === undefined ? {} : { policy: input.policy }),
			});
			return { verification, decision };
		};
		const harness = defineTrainingHarness<CandidatePatch, CandidateAssessment, string>({
			candidateId: (candidate) => candidate.id,
			...(input.maxRounds === undefined ? {} : { maxRounds: input.maxRounds }),
		});
		const bus = new WriteAheadAgentBus({ file: resolve(outputDir, "harness-actions.jsonl") });
		const result = await harness.run<CandidateAssessment>({
			bus,
			task: { trainable: toTrainableToken(input.trainable).id, objective: input.objective },
			rubric: promotionRubric(input),
			...(input.signal === undefined ? {} : { signal: input.signal }),
			student: async ({ feedback, signal }) => {
				const constraints = [
					...(input.constraints ?? []),
					...feedback.map((failure) => `Previous candidate rejection: ${failure}`),
				];
				return this.optimize({
					trainable: input.trainable,
					objective: input.objective,
					evaluations,
					...(constraints.length === 0 ? {} : { constraints }),
					...(input.engine === undefined ? {} : { engine: input.engine }),
					...(signal === undefined ? {} : { signal }),
				});
			},
			teacher: async (candidate, { round, signal }) => {
				const assessment = await assess(candidate, `${outputDir}/candidate-${round}`, signal);
				evaluations = [...evaluations, ...assessment.verification.evaluations];
				return { assessment, feedback: assessment.decision.failures };
			},
			judge: (input) => {
				const request = input as JudgeRequest<CandidatePatch, CandidateAssessment, CandidateAssessment>;
				if (request.subject === "action") return "pass";
				if (request.subject === "candidate") return request.assessment.decision.promote ? "pass" : "fail";
				if (!request.challenge.decision.promote) {
					evaluations = [...evaluations, ...request.challenge.verification.evaluations];
					return "pass";
				}
				return "fail";
			},
			adversary: (candidate, { signal }) => assess(candidate, `${outputDir}/adversary-${candidate.id}`, signal),
			reviseRubric: (challenge, { rubric }) => ({
				rubric: `${rubric}\nAdversarial criteria: ${challenge.decision.failures.join("; ")}`,
				feedback: challenge.decision.failures,
			}),
		});
		const rounds = result.rounds.map(({ round, candidate, assessment }) =>
			Object.freeze({ round, candidate, ...assessment }));
		return Object.freeze({
			outcome: result.outcome === "accepted" ? "ready" : result.outcome,
			baseline,
			rounds: Object.freeze(rounds),
			final: rounds.at(-1) as TrainingRound,
		});
	}

	async evolve(input: EvolveInput): Promise<EvolveResult> {
		const { evaluation = {}, minTraces = 1, ...training } = input;
		if (!Number.isInteger(minTraces) || minTraces < 1) {
			throw new TypeError("minTraces must be a positive integer");
		}
		const examples = liveEvalCases(await this.records(input.trainable));
		if (examples.length < minTraces) {
			throw new Error(`code evolution requires ${minTraces} distinct successful runtime trace${minTraces === 1 ? "" : "s"}; found ${examples.length}`);
		}
		const expected = new Map(examples.map((test) => [String(test.input), test.expectedOutput ?? ""]));
		const run = await this.train({
			...training,
			evaluation: {
				...evaluation,
				tests: examples,
				task: (value) => {
					const output = expected.get(value);
					if (output === undefined) throw new Error(`live trace was not found for eval input: ${value}`);
					return output;
				},
			},
		});
		if (run.outcome !== "ready") {
			throw new Error(`code evolution did not produce a promotable candidate: ${run.outcome}`);
		}
		return Object.freeze({
			training: run,
			promotion: await this.promote(run.final.candidate, run.final.decision),
		});
	}

	#remember(run: TrainableEvalRun): void {
		const token = run.token;
		const evaluations = this.#evaluations.get(token.id) ?? [];
		evaluations.push(...run.evaluations);
		this.#evaluations.set(token.id, evaluations);
	}

	async optimize(input: OptimizeInput): Promise<CandidatePatch> {
		const token = toTrainableToken(input.trainable);
		const target = input.target ?? findTrainable(token.id, this.#settings.source);
		const records = await this.records(token);
		return optimizeCandidate(
			this.#engineFor(input.engine),
			{
				trainableId: token.id,
				objective: input.objective,
				target,
				records,
				evaluations: input.evaluations ?? this.#evaluations.get(token.id) ?? [],
				...(input.constraints === undefined ? {} : { constraints: input.constraints }),
			},
			{
				variables: this.#settings.variables ?? {},
				...(this.#settings.secrets === undefined ? {} : { secrets: this.#settings.secrets }),
				...(input.signal === undefined ? {} : { signal: input.signal }),
			},
		);
	}

	async optimizeAll(inputs: readonly OptimizeInput[]): Promise<readonly CandidatePatch[]> {
		const needsDiscovery = inputs.some((input) => input.target === undefined);
		const targets = needsDiscovery ? targetsById(discoverTrainables(this.#settings.source)) : new Map();
		const prepared = inputs.map((input): OptimizeInput => {
			if (input.target) return input;
			const id = toTrainableToken(input.trainable).id;
			const target = targets.get(id);
			if (!target) throw new Error(`trainable source was not found: ${id}`);
			return { ...input, target };
		});
		return mapConcurrent(prepared, this.#settings.concurrency, (input) => this.optimize(input));
	}

	async promote(candidate: CandidatePatch, decision: PromotionDecision): Promise<PromotionResult> {
		const source = await readFile(candidate.target.artifactRef, "utf8");
		const promoted = promoteCandidate({ source, candidate, decision });
		await writeFile(candidate.target.artifactRef, promoted.source, "utf8");
		this.#hotSwap(candidate);
		return promoted;
	}

	async revert(snapshot: PromotionSnapshot): Promise<void> {
		const source = await readFile(snapshot.artifactRef, "utf8");
		await writeFile(snapshot.artifactRef, revertPromotion(source, snapshot), "utf8");
		restoreImplementation(snapshot.trainableId);
	}

	/** Promoted candidates go live in-process through the hot-swappable advice.
	 * Only async targets swap: the executor returns a promise, so swapping a
	 * synchronous method would change its calling convention. */
	#hotSwap(candidate: CandidatePatch): void {
		if (!candidate.target.async) return;
		const executor = this.#settings.executor ?? defaultProviders.executor;
		if (!executor) return;
		// Normal function so the call receiver is captured and forwarded to
		// executors that can bind it (the sandbox executor ignores it).
		swapImplementation(candidate.trainableId, function (this: unknown, ...args: unknown[]) {
			return executor(candidate.target, candidate.implementation, args, { receiver: this });
		});
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
		if (this.#settings.tracing.enabled === false) {
			return this.#execute(thisValue, method, args, token, name);
		}
		const attributes: Attributes = {
			...this.#settings.tracing.attributes,
			[SemanticConventions.OPENINFERENCE_SPAN_KIND]: this.#settings.tracing.kind ?? OpenInferenceSpanKind.CHAIN,
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
		const startedAt = this.#settings.now();
		const runId = this.#settings.idFactory();
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
		const endedAt = this.#settings.now();
		if (span) {
			if (error === undefined) span.setStatus({ code: SpanStatusCode.OK });
			else {
				span.recordException(error instanceof Error ? error : String(error));
				span.setStatus({ code: SpanStatusCode.ERROR });
			}
			span.end();
		}
		if (this.#settings.capture.enabled === false) return;
		try {
			const spanContext = span?.spanContext();
			const input = this.#settings.capture.mapInput ? this.#settings.capture.mapInput(args, token) : args;
			const output = error === undefined
				? (this.#settings.capture.mapOutput ? this.#settings.capture.mapOutput(result, token) : result)
				: errorMessage(error);
			const record: TrainingRecord = {
				id: this.#settings.idFactory(),
				runId,
				trainableId: token.id,
				method: name,
				succeeded: error === undefined,
				recordedAt: endedAt.toISOString(),
				trace: buildTraceFromMessages({
					input: this.#settings.capture.input === false ? [] : [{ role: "user", content: this.#serialize(input, "input") }],
					output: this.#settings.capture.output === false ? [] : [{ role: "assistant", content: this.#serialize(output, "output") }],
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

	#serialize(value: unknown, field: "input" | "output"): string {
		const redacted = this.#settings.capture.redact ? this.#settings.capture.redact(value, field) : value;
		return (this.#settings.capture.serialize ?? defaultSerialize)(redacted);
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
	readonly evolution?: EvolutionSettings;
}

let defaultProviders: TrainingProviders = {};

/** Provider packages call this to supply lazy fallbacks (ts-autocode wires Ax)
 * without this package depending on any provider. Explicit settings win. */
export function provideTrainingDefaults(providers: TrainingProviders): void {
	defaultProviders = { ...defaultProviders, ...providers };
}

/** Default runtime: the "use training" directive is the only required marker.
 * `configureTraining()` is optional and only overrides settings; each call
 * delegates to the current runtime so later configuration still applies. */
export const training: Training = Object.freeze<Training>({
	records: (identity) => runtime().records(identity),
	evaluate: (identity, config) => runtime().evaluate(identity, config),
	evaluateCandidate: (candidate, config) => runtime().evaluateCandidate(candidate, config),
	train: (input) => runtime().train(input),
	evolve: (input) => runtime().evolve(input),
	optimize: (input) => runtime().optimize(input),
	optimizeAll: (inputs) => runtime().optimizeAll(inputs),
	promote: (candidate, decision) => runtime().promote(candidate, decision),
	revert: (snapshot) => runtime().revert(snapshot),
	flush: () => runtime().flush(),
});

const wrappedMarker = Symbol.for("ts-autocode.wrapped");

/** Decorator form: `@trainable()`. Identity is inferred from the class that
 * declares the method; pass a symbol (for example `defineTrainable("Router.route").symbol`)
 * only to override the inferred id. The method is woven through the
 * ts-autocode-rewrite aspect under the "use training" marker at first
 * construction, so promoted candidates can hot-swap it. */
export function trainable(identity?: symbol): TrainableDecorator {
	if (identity !== undefined && typeof identity !== "symbol") {
		throw new TypeError("trainable identity must be a symbol; omit it to infer from the decorated method");
	}
	const explicit = identity === undefined ? undefined : trainableTokenFromSymbol(identity);
	return function <This, Args extends unknown[], Result>(
		method: (this: This, ...args: Args) => Result,
		context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
	) {
		const name = String(context.name);
		context.addInitializer(function (this: This) {
			const owner = (context.static ? this : (this as object).constructor) as abstract new (...args: never[]) => unknown;
			// Infer from the class that actually declares the method, so a base method
			// first initialized through a subclass still resolves to Base.method.
			const id = explicit?.id ?? `${declaringClassName(owner, name, context.static) ?? "Anonymous"}.${name}`;
			annotateRewrite(owner, name, id, trainingMarker);
		});
		return method;
	};
}

/** Load-time instrumentation (`ts-autocode/register`): wrap a directive-marked free
 * function through the same hot-swappable dispatch as woven methods. Idempotent. */
export function wrapTrainable<F extends (...args: never[]) => unknown>(fn: F, id: string): F {
	if ((fn as Partial<Record<typeof wrappedMarker, boolean>>)[wrappedMarker]) return fn;
	const name = fn.name || id;
	const method = fn as unknown as (this: unknown, ...args: unknown[]) => unknown;
	const wrapped = function (this: unknown, ...args: unknown[]): unknown {
		return dispatchRewrite(id, trainingMarker, name, method, this, args);
	};
	Object.defineProperty(wrapped, "name", { value: name, configurable: true });
	Object.defineProperty(wrapped, wrappedMarker, { value: true });
	return wrapped as unknown as F;
}

/** Load-time instrumentation (`ts-autocode/register`): weave a directive-marked
 * class method through the ts-autocode-rewrite aspect. Idempotent. */
export function instrumentTrainable(
	owner: abstract new (...args: never[]) => unknown,
	methodName: string,
	id: string,
): void {
	annotateRewrite(owner, methodName, id, trainingMarker);
}

/** Name of the class that declares `methodName`, walking to the owning prototype
 * so an inherited method resolves to its base class rather than a subclass. */
function declaringClassName(
	owner: abstract new (...args: never[]) => unknown,
	methodName: string,
	isStatic: boolean,
): string | undefined {
	const container = declaringContainer(owner, methodName);
	const constructor = isStatic ? container : (container as { constructor?: unknown } | undefined)?.constructor;
	return typeof constructor === "function" && constructor.name ? constructor.name : undefined;
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
		input.conformance === false ? "Source conformance checks are disabled." : "Candidate must pass source conformance checks.",
		`Minimum evaluation score: ${input.minScore ?? "evaluation default"}.`,
		`Minimum evaluation pass rate: ${input.minPassRate ?? 1}.`,
		input.policy === undefined ? "No additional promotion policy." : "Candidate must pass the configured promotion policy.",
	].join(" ");
}

async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, map: (item: T) => Promise<R>): Promise<R[]> {
	if (items.length === 0) return [];
	const limit = concurrency === Number.POSITIVE_INFINITY ? items.length : Math.min(concurrency, items.length);
	const results = new Array<R>(items.length);
	let next = 0;
	await Promise.all(Array.from({ length: limit }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await map(items[index] as T);
		}
	}));
	return results;
}

function targetsById(targets: readonly TrainableTarget[]): ReadonlyMap<string, TrainableTarget> {
	const result = new Map<string, TrainableTarget>();
	for (const target of targets) {
		if (result.has(target.id)) throw new Error(`trainable id must resolve to exactly one method: ${target.id}`);
		result.set(target.id, target);
	}
	return result;
}
