import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { buildTraceFromMessages, type EvalConfig } from "@agentv/core";
import { OpenInferenceSpanKind, SemanticConventions } from "@arizeai/openinference-semantic-conventions";
import { SpanStatusCode, trace, type Attributes, type Span, type Tracer } from "@opentelemetry/api";

import {
	optimizeCandidate,
	type BoundEvaluation,
	type CandidatePatch,
	type SecretProvider,
	type TrainingEngine,
} from "./engine.js";
import { evaluateTrainable, type TrainableEvalRun } from "./evaluation.js";
import { executeImplementation } from "./execution.js";
import {
	evaluatePromotionGate,
	promoteCandidate,
	revertPromotion,
	type PromotionDecision,
	type PromotionResult,
	type PromotionSnapshot,
} from "./promotion.js";
import { createAxEngine } from "./providers/ax.js";
import { createMemoryTrainingStore, type TrainingRecord, type TrainingStore } from "./records.js";
import {
	discoverTrainables,
	findTrainable,
	type SourceSettings,
	type TrainableTarget,
} from "./source.js";
import { defineTrainable, toTrainableToken, type TrainableIdentity, type TrainableToken } from "./token.js";

const trainableAttribute = "ts_autocode.trainable.id";

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

export interface TrainingSettings {
	readonly engine?: TrainingEngine;
	readonly source?: SourceSettings;
	readonly store?: TrainingStore;
	readonly secrets?: SecretProvider;
	readonly variables?: Readonly<Record<string, string>>;
	readonly concurrency?: number;
	readonly capture?: CaptureSettings;
	readonly tracing?: TracingSettings;
	readonly idFactory?: () => string;
	readonly now?: () => Date;
	readonly onError?: (error: unknown, phase: "capture" | "store") => void;
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

export type CandidateEvalConfig = Omit<EvalConfig, "task">;

export interface TrainInput {
	readonly trainable: TrainableIdentity;
	readonly objective: string;
	readonly evaluation: EvalConfig;
	readonly constraints?: readonly string[];
	readonly engine?: TrainingEngine;
	readonly signal?: AbortSignal;
	readonly minScore?: number;
	readonly minPassRate?: number;
	readonly conformance?: boolean;
	readonly policy?: (candidate: CandidatePatch) => boolean | Promise<boolean>;
}

export interface TrainingRun {
	readonly baseline: TrainableEvalRun;
	readonly candidate: CandidatePatch;
	readonly verification: TrainableEvalRun;
	readonly decision: PromotionDecision;
}

export interface Training {
	records(trainable?: TrainableIdentity): Promise<readonly TrainingRecord[]>;
	evaluate(trainable: TrainableIdentity, config: EvalConfig): Promise<TrainableEvalRun>;
	evaluateCandidate(candidate: CandidatePatch, config: CandidateEvalConfig): Promise<TrainableEvalRun>;
	train(input: TrainInput): Promise<TrainingRun>;
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
	readonly #engine: TrainingEngine;
	readonly #store: TrainingStore;
	readonly #tracer: Tracer;
	readonly #pending = new Set<Promise<void>>();
	readonly #evaluations = new Map<string, BoundEvaluation[]>();

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
		this.#engine = settings.engine ?? createAxEngine();
		this.#store = settings.store ?? createMemoryTrainingStore();
		this.#tracer = this.#settings.tracing.tracer ?? trace.getTracer("ts-autocode");
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
		const evaluated = await evaluateTrainable(token, {
			...config,
			task: async (input) => {
				const output = await executeImplementation(
					candidate.target,
					candidate.implementation,
					evaluationArgs(input),
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
		const candidate = await this.optimize({
			trainable: input.trainable,
			objective: input.objective,
			evaluations: baseline.evaluations,
			...(input.constraints === undefined ? {} : { constraints: input.constraints }),
			...(input.engine === undefined ? {} : { engine: input.engine }),
			...(input.signal === undefined ? {} : { signal: input.signal }),
		});
		const { task: _task, outputDir, ...candidateEvaluation } = input.evaluation;
		const verification = await this.evaluateCandidate(candidate, {
			...candidateEvaluation,
			outputDir: `${outputDir ?? ".agentv"}/candidate`,
		});
		const decision = await evaluatePromotionGate({
			candidate,
			evaluations: verification.evaluations,
			conformance: input.conformance ?? true,
			...(input.minScore === undefined ? {} : { minScore: input.minScore }),
			...(input.minPassRate === undefined ? {} : { minPassRate: input.minPassRate }),
			...(input.policy === undefined ? {} : { policy: input.policy }),
		});
		return Object.freeze({ baseline, candidate, verification, decision });
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
			input.engine ?? this.#engine,
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
		return promoted;
	}

	async revert(snapshot: PromotionSnapshot): Promise<void> {
		const source = await readFile(snapshot.artifactRef, "utf8");
		await writeFile(snapshot.artifactRef, revertPromotion(source, snapshot), "utf8");
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
			const input = this.#settings.capture.mapInput?.(args, token) ?? args;
			const output = error === undefined
				? this.#settings.capture.mapOutput?.(result, token) ?? result
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
		} catch (captureError) {
			this.#settings.onError?.(captureError, "capture");
		}
	}

	#serialize(value: unknown, field: "input" | "output"): string {
		const redacted = this.#settings.capture.redact?.(value, field) ?? value;
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

/** Decorator form: `@trainable("Router.route")`. */
export function trainable(identity: TrainableIdentity): TrainableDecorator {
	const token = toTrainableToken(identity);
	return function <This, Args extends unknown[], Result>(
		method: (this: This, ...args: Args) => Result,
		context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
	) {
		const name = String(context.name);
		return function (this: This, ...args: Args): Result {
			return runtime().invoke(this, method, args, token, name);
		};
	};
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
		return JSON.stringify(value);
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
