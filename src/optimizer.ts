import { SpanStatusCode, trace, type Span, type Tracer } from "@opentelemetry/api";
import {
	optimize as optimizeWithAx,
	type AxAIService,
	type AxGenOut,
	type AxMetricFn,
	type AxMultiMetricFn,
	type AxOptimizeOptions,
	type AxProgrammable,
	type AxTypedExample,
} from "@ax-llm/ax";

import { digest } from "./canonical.js";
import {
	type CandidateEdit,
	type CandidatePatch,
	type OptimizationRequest,
	type RegionOptimizationSummary,
} from "./engine.js";
import type { GeneratedRegion } from "./region.js";

const attributes = {
	artifact: "ts_autocode.artifact.ref",
	bestScore: "ts_autocode.optimization.best_score",
	region: "ts_autocode.region.id",
	regionCount: "ts_autocode.region.count",
} as const;

export interface RegionOptimizationContext<Data> {
	readonly region: GeneratedRegion;
	readonly currentSource: string;
	readonly data: Data;
}

export interface AxOptimizerOptions<IN, OUT extends AxGenOut, Data> {
	readonly studentAI: AxAIService;
	readonly teacherAI?: AxAIService;
	readonly program: (context: RegionOptimizationContext<Data>) => AxProgrammable<IN, OUT>;
	readonly examples: (context: RegionOptimizationContext<Data>) => readonly AxTypedExample<IN>[];
	readonly metric: (input: Readonly<{ prediction: OUT; example: AxTypedExample<IN> }>) =>
		| ReturnType<AxMetricFn>
		| ReturnType<AxMultiMetricFn>;
	/** Input used for the final forward pass after Ax applies the optimized program. */
	readonly input: (context: RegionOptimizationContext<Data>) => IN;
	readonly replacement: (output: OUT, context: RegionOptimizationContext<Data>) => string;
	readonly ax?: Omit<AxOptimizeOptions, "studentAI" | "teacherAI">;
	/** Independent regions run concurrently. Defaults to all regions. */
	readonly concurrency?: number;
	/** Official OpenTelemetry tracer. Ax may also be configured with the same provider. */
	readonly tracer?: Tracer;
}

/** Optimize every region with Ax. Independent regions train concurrently. */
export async function optimizeRegions<IN, OUT extends AxGenOut, Data>(
	request: OptimizationRequest<Data>,
	options: AxOptimizerOptions<IN, OUT, Data>,
): Promise<CandidatePatch> {
	if (request.regions.length === 0) {
		throw new TypeError("at least one generated region is required");
	}
	if (new Set(request.regions.map((region) => region.regionId)).size !== request.regions.length) {
		throw new TypeError("region ids must be unique");
	}
	const concurrency = options.concurrency ?? request.regions.length;
	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw new TypeError("concurrency must be a positive integer");
	}

	const tracer = options.tracer ?? trace.getTracer("ts-autocode");
	return inSpan(tracer, "ts-autocode.optimize", async (span) => {
		span.setAttribute(attributes.regionCount, request.regions.length);
		const optimized = await mapConcurrent(request.regions, concurrency, (region) =>
			optimizeRegion(request, options, region, tracer),
		);
		const edits = optimized.map(({ edit }) => edit);
		const optimization = optimized.map(({ summary }) => summary);
		return Object.freeze({
			id: digest({ edits, optimization }),
			edits,
			optimization,
		});
	});
}

async function optimizeRegion<IN, OUT extends AxGenOut, Data>(
	request: OptimizationRequest<Data>,
	options: AxOptimizerOptions<IN, OUT, Data>,
	region: GeneratedRegion,
	tracer: Tracer,
): Promise<{ edit: CandidateEdit; summary: RegionOptimizationSummary }> {
	return inSpan(tracer, "ts-autocode.optimize.region", async (span) => {
		span.setAttribute(attributes.artifact, region.artifactRef);
		span.setAttribute(attributes.region, region.regionId);

		const source = request.artifacts[region.artifactRef];
		if (source === undefined) {
			throw new Error(`artifact is missing: ${region.artifactRef}`);
		}
		if (digest(source.slice(region.startOffset, region.endOffset)) !== region.sourceDigest) {
			throw new Error(`generated region is stale: ${region.regionId}`);
		}

		const context = {
			region,
			currentSource: source.slice(region.startOffset, region.endOffset),
			data: request.data,
		};
		const program = options.program(context);
		const examples = options.examples(context);
		if (examples.length === 0) {
			throw new Error(`Ax requires training examples for region: ${region.regionId}`);
		}

		const result = await optimizeWithAx(program, examples, options.metric as AxMetricFn | AxMultiMetricFn, {
			...options.ax,
			studentAI: options.studentAI,
			...(options.teacherAI === undefined ? {} : { teacherAI: options.teacherAI }),
		});
		if (result.optimizedProgram === undefined) {
			throw new Error(`Ax did not return an optimized program for region: ${region.regionId}`);
		}
		program.applyOptimization(result.optimizedProgram);
		const output = await program.forward(options.studentAI, options.input(context));
		const replacement = options.replacement(output, context);
		if (typeof replacement !== "string") {
			throw new TypeError(`replacement must be a string for region: ${region.regionId}`);
		}

		span.setAttribute(attributes.bestScore, result.bestScore);
		return {
			edit: {
				artifactRef: region.artifactRef,
				regionId: region.regionId,
				startOffset: region.startOffset,
				endOffset: region.endOffset,
				replacement,
			},
			summary: {
				regionId: region.regionId,
				bestScore: result.bestScore,
				optimizerType: result.optimizedProgram.optimizerType,
				converged: result.optimizedProgram.converged,
				rounds: result.optimizedProgram.totalRounds,
			},
		};
	});
}

async function inSpan<T>(tracer: Tracer, name: string, work: (span: Span) => Promise<T>): Promise<T> {
	return tracer.startActiveSpan(name, async (span) => {
		try {
			const result = await work(span);
			span.setStatus({ code: SpanStatusCode.OK });
			return result;
		} catch (error) {
			span.recordException(error instanceof Error ? error : String(error));
			span.setStatus({ code: SpanStatusCode.ERROR });
			throw error;
		} finally {
			span.end();
		}
	});
}

async function mapConcurrent<T, R>(
	items: readonly T[],
	concurrency: number,
	map: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await map(items[index] as T);
		}
	});
	await Promise.all(workers);
	return results;
}
