import { randomUUID } from "node:crypto";

import { buildTraceFromMessages, type EvalConfig } from "@agentv/core";
import {
	OpenInferenceSpanKind,
	SemanticConventions,
} from "@arizeai/openinference-semantic-conventions";
import {
	SpanStatusCode,
	trace,
	type Attributes,
	type Span,
	type Tracer,
} from "@opentelemetry/api";

import {
	type BoundEvaluation,
	type CandidatePatch,
	type SecretProvider,
	type TrainingEngine,
	optimizeCandidate,
} from "./engine.js";
import { evaluateTrainable, type TrainableEvalRun } from "./evaluation.js";
import type { GeneratedRegion } from "./region.js";
import {
	createMemoryTrainingStore,
	type TrainingRecord,
	type TrainingStore,
} from "./records.js";
import type { TrainableToken } from "./token.js";

const attribute = {
	artifact: "ts_autocode.artifact.ref",
	region: "ts_autocode.region.id",
	trainable: "ts_autocode.trainable.id",
} as const;

export interface CaptureSettings {
	readonly input?: boolean;
	readonly output?: boolean;
	readonly serialize?: (value: unknown) => string;
	readonly redact?: (value: unknown, field: "input" | "output") => unknown;
}

export interface TrainingSettings {
	readonly engine?: TrainingEngine;
	readonly store?: TrainingStore;
	readonly tracer?: Tracer;
	readonly secrets?: SecretProvider;
	readonly variables?: Readonly<Record<string, string>>;
	readonly concurrency?: number;
	readonly capture?: CaptureSettings;
	readonly idFactory?: () => string;
	readonly now?: () => Date;
	readonly onError?: (error: unknown, phase: "capture" | "store") => void;
}

type RegionResolver = GeneratedRegion | ((instance: unknown, args: readonly unknown[]) => GeneratedRegion);

export interface BoundTrainableOptions {
	readonly token: TrainableToken;
	readonly region: RegionResolver;
	readonly name?: string;
	readonly kind?: OpenInferenceSpanKind;
	readonly attributes?: Attributes;
	readonly mapInput?: (args: readonly unknown[]) => unknown;
	readonly mapOutput?: (result: unknown) => unknown;
	readonly runId?: () => string;
}

export interface TrainableOptions extends BoundTrainableOptions {
	readonly training: TrainingSession;
}

export type TrainableDecorator = <This, Args extends unknown[], Result>(
	method: (this: This, ...args: Args) => Result,
	context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
) => (this: This, ...args: Args) => Result;

export interface OptimizeInput {
	readonly token: TrainableToken;
	readonly objective: string;
	readonly artifacts: Readonly<Record<string, string>>;
	readonly regions?: readonly GeneratedRegion[];
	readonly constraints?: readonly string[];
	readonly evaluations?: readonly BoundEvaluation[];
	readonly engine?: TrainingEngine;
	readonly signal?: AbortSignal;
}

export class TrainingSession {
	readonly #settings: Required<Pick<TrainingSettings, "capture" | "concurrency" | "idFactory" | "now">> &
		Omit<TrainingSettings, "capture" | "concurrency" | "idFactory" | "now">;
	readonly #store: TrainingStore;
	readonly #tracer: Tracer;
	readonly #pending = new Set<Promise<void>>();
	readonly #regions = new Map<string, Map<string, GeneratedRegion>>();
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
			variables: Object.freeze({ ...settings.variables }),
		};
		this.#store = settings.store ?? createMemoryTrainingStore();
		this.#tracer = settings.tracer ?? trace.getTracer("ts-autocode");
	}

	trainable(options: BoundTrainableOptions): TrainableDecorator {
		const session = this;
		return function <This, Args extends unknown[], Result>(
			method: (this: This, ...args: Args) => Result,
			context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
		) {
			const name = options.name ?? String(context.name);
			return function (this: This, ...args: Args): Result {
				const region = resolveRegion(options.region, this, args);
				session.#register(options.token, region);
				const attributes: Attributes = {
					...options.attributes,
					[SemanticConventions.OPENINFERENCE_SPAN_KIND]: options.kind ?? OpenInferenceSpanKind.CHAIN,
					[attribute.artifact]: region.artifactRef,
					[attribute.region]: region.regionId,
					[attribute.trainable]: options.token.id,
				};

				return session.#tracer.startActiveSpan(name, { attributes }, (span) => {
					const startedAt = session.#settings.now();
					const runId = options.runId?.() ?? session.#settings.idFactory();
					let result: Result;
					try {
						result = method.apply(this, args);
					} catch (error) {
						session.#finish({ span, error, args, name, options, region, runId, startedAt });
						throw error;
					}

					if (isPromise(result)) {
						return result.then(
							(value) => {
								session.#finish({ span, result: value, args, name, options, region, runId, startedAt });
								return value;
							},
							(error) => {
								session.#finish({ span, error, args, name, options, region, runId, startedAt });
								throw error;
							},
						) as Result;
					}

					session.#finish({ span, result, args, name, options, region, runId, startedAt });
					return result;
				});
			};
		};
	}

	async records(token?: TrainableToken): Promise<readonly TrainingRecord[]> {
		await this.flush();
		return this.#store.list(token?.id);
	}

	regions(token: TrainableToken): readonly GeneratedRegion[] {
		return [...(this.#regions.get(token.id)?.values() ?? [])];
	}

	async evaluate(token: TrainableToken, config: EvalConfig): Promise<TrainableEvalRun> {
		const run = await evaluateTrainable(token, config);
		const existing = this.#evaluations.get(token.id) ?? [];
		existing.push(...run.evaluations);
		this.#evaluations.set(token.id, existing);
		return run;
	}

	async optimize(input: OptimizeInput): Promise<CandidatePatch> {
		const engine = input.engine ?? this.#settings.engine;
		if (!engine) {
			throw new Error("no training engine is configured");
		}
		const regions = input.regions ?? this.regions(input.token);
		const records = await this.records(input.token);
		return optimizeCandidate(
			engine,
			{
				trainableId: input.token.id,
				objective: input.objective,
				artifacts: input.artifacts,
				regions,
				records,
				evaluations: input.evaluations ?? this.#evaluations.get(input.token.id) ?? [],
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
		return mapConcurrent(inputs, this.#settings.concurrency, (input) => this.optimize(input));
	}

	async flush(): Promise<void> {
		await Promise.all([...this.#pending]);
	}

	#register(token: TrainableToken, region: GeneratedRegion): void {
		const regions = this.#regions.get(token.id) ?? new Map<string, GeneratedRegion>();
		regions.set(`${region.artifactRef}:${region.regionId}`, region);
		this.#regions.set(token.id, regions);
	}

	#finish({
		span,
		result,
		error,
		args,
		name,
		options,
		region,
		runId,
		startedAt,
	}: {
		span: Span;
		result?: unknown;
		error?: unknown;
		args: readonly unknown[];
		name: string;
		options: BoundTrainableOptions;
		region: GeneratedRegion;
		runId: string;
		startedAt: Date;
	}): void {
		const endedAt = this.#settings.now();
		if (error === undefined) {
			span.setStatus({ code: SpanStatusCode.OK });
		} else {
			span.recordException(error instanceof Error ? error : String(error));
			span.setStatus({ code: SpanStatusCode.ERROR });
		}
		const spanContext = span.spanContext();
		span.end();

		try {
			const input = options.mapInput?.(args) ?? args;
			const output = error === undefined ? options.mapOutput?.(result) ?? result : errorMessage(error);
			const record: TrainingRecord = {
				id: this.#settings.idFactory(),
				runId,
				trainableId: options.token.id,
				method: name,
				region,
				succeeded: error === undefined,
				recordedAt: endedAt.toISOString(),
				trace: buildTraceFromMessages({
					input: this.#settings.capture.input === false ? [] : [{ role: "user", content: this.#serialize(input, "input") }],
					output:
						this.#settings.capture.output === false
							? []
							: [{ role: "assistant", content: this.#serialize(output, "output") }],
					startTime: startedAt.toISOString(),
					endTime: endedAt.toISOString(),
					durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
					provider: "ts-autocode",
					target: options.token.id,
					metadata: {
						runId,
						trainableId: options.token.id,
						regionId: region.regionId,
						traceId: spanContext.traceId,
						spanId: spanContext.spanId,
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
		const pending = write.catch((error) => {
			this.#settings.onError?.(error, "store");
		}).finally(() => {
			this.#pending.delete(pending);
		});
		this.#pending.add(pending);
	}
}

export function createTraining(settings: TrainingSettings): TrainingSession {
	return new TrainingSession(settings);
}

/** Concise settings-bound API; equivalent to createTraining(settings). */
export function useTraining(settings: TrainingSettings): TrainingSession {
	return createTraining(settings);
}

/** Standalone decorator form. */
export function trainable(options: TrainableOptions): TrainableDecorator {
	const { training, ...bound } = options;
	return training.trainable(bound);
}

function resolveRegion(resolver: RegionResolver, instance: unknown, args: readonly unknown[]): GeneratedRegion {
	return typeof resolver === "function" ? resolver(instance, args) : resolver;
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

async function mapConcurrent<T, R>(
	items: readonly T[],
	concurrency: number,
	map: (item: T) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) return [];
	const limit = concurrency === Number.POSITIVE_INFINITY ? items.length : Math.min(concurrency, items.length);
	const results = new Array<R>(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: limit }, async () => {
			while (next < items.length) {
				const index = next++;
				results[index] = await map(items[index] as T);
			}
		}),
	);
	return results;
}
