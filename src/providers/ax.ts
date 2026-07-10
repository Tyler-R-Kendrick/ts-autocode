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

import { digest } from "../canonical.js";
import type {
	CandidateEdit,
	EngineContext,
	OptimizeRequest,
	TrainingEngine,
} from "../engine.js";
import type { GeneratedRegion } from "../region.js";

export interface AxRegionContext<Data = OptimizeRequest> {
	readonly request: Data;
	readonly region: GeneratedRegion;
	readonly currentSource: string;
	readonly engineContext: EngineContext;
}

type Service = AxAIService | ((context: EngineContext) => AxAIService | Promise<AxAIService>);

export interface AxEngineOptions<IN, OUT extends AxGenOut> {
	readonly id?: string;
	readonly studentAI: Service;
	readonly teacherAI?: Service;
	readonly program: (context: AxRegionContext) => AxProgrammable<IN, OUT>;
	readonly examples: (context: AxRegionContext) => readonly AxTypedExample<IN>[];
	readonly metric: (input: Readonly<{ prediction: OUT; example: AxTypedExample<IN> }>) =>
		| ReturnType<AxMetricFn>
		| ReturnType<AxMultiMetricFn>;
	readonly input: (context: AxRegionContext) => IN;
	readonly replacement: (output: OUT, context: AxRegionContext) => string;
	readonly optimize?: Omit<AxOptimizeOptions, "studentAI" | "teacherAI">;
	readonly concurrency?: number;
}

/** Optional Ax adapter; the core accepts any TrainingEngine implementation. */
export function createAxEngine<IN, OUT extends AxGenOut>(options: AxEngineOptions<IN, OUT>): TrainingEngine {
	const id = options.id ?? "@ax-llm/ax";
	return Object.freeze({
		id,
		async optimize(request: OptimizeRequest, engineContext: EngineContext) {
			const studentAI = await resolveService(options.studentAI, engineContext);
			const teacherAI =
				options.teacherAI === undefined ? undefined : await resolveService(options.teacherAI, engineContext);
			const optimized = await mapConcurrent(
				request.regions,
				options.concurrency ?? request.regions.length,
				async (region) => {
					const source = request.artifacts[region.artifactRef] as string;
					const context: AxRegionContext = {
						request,
						region,
						currentSource: source.slice(region.startOffset, region.endOffset),
						engineContext,
					};
					const program = options.program(context);
					const examples = options.examples(context);
					if (examples.length === 0) {
						throw new Error(`Ax requires examples for region: ${region.regionId}`);
					}
					const result = await optimizeWithAx(
						program,
						examples,
						options.metric as AxMetricFn | AxMultiMetricFn,
						{
							...options.optimize,
							studentAI,
							...(teacherAI === undefined ? {} : { teacherAI }),
						},
					);
					if (!result.optimizedProgram) {
						throw new Error(`Ax did not return an optimized program for region: ${region.regionId}`);
					}
					program.applyOptimization(result.optimizedProgram);
					const output = await program.forward(studentAI, options.input(context), {
						...(engineContext.signal === undefined ? {} : { abortSignal: engineContext.signal }),
					});
					const replacement = options.replacement(output, context);
					if (typeof replacement !== "string") {
						throw new TypeError(`replacement must be a string for region: ${region.regionId}`);
					}
					return {
						edit: {
							artifactRef: region.artifactRef,
							regionId: region.regionId,
							startOffset: region.startOffset,
							endOffset: region.endOffset,
							replacement,
						} satisfies CandidateEdit,
						summary: {
							regionId: region.regionId,
							bestScore: result.bestScore,
							optimizerType: result.optimizedProgram.optimizerType,
							converged: result.optimizedProgram.converged,
							rounds: result.optimizedProgram.totalRounds,
						},
					};
				},
			);
			const edits = optimized.map(({ edit }) => edit);
			const metadata = { regions: optimized.map(({ summary }) => summary) };
			return {
				id: digest({ trainableId: request.trainableId, engineId: id, edits, metadata }),
				trainableId: request.trainableId,
				engineId: id,
				edits,
				metadata,
			};
		},
	});
}

async function resolveService(service: Service, context: EngineContext): Promise<AxAIService> {
	return typeof service === "function" ? service(context) : service;
}

async function mapConcurrent<T, R>(
	items: readonly T[],
	concurrency: number,
	map: (item: T) => Promise<R>,
): Promise<R[]> {
	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw new TypeError("Ax concurrency must be a positive integer");
	}
	const results = new Array<R>(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, async () => {
			while (next < items.length) {
				const index = next++;
				results[index] = await map(items[index] as T);
			}
		}),
	);
	return results;
}
