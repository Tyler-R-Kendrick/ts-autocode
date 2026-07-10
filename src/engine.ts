import type { EvaluationResult } from "@agentv/core";

import { digest } from "./canonical.js";
import type { GeneratedRegion } from "./region.js";
import type { TrainingRecord } from "./records.js";
import type { TrainableId } from "./token.js";

export interface SecretProvider {
	get(name: string, signal?: AbortSignal): Promise<string | undefined>;
}

export interface BoundEvaluation {
	readonly trainableId: TrainableId;
	readonly result: EvaluationResult;
}

export interface OptimizeRequest {
	readonly trainableId: TrainableId;
	readonly objective: string;
	readonly artifacts: Readonly<Record<string, string>>;
	readonly regions: readonly GeneratedRegion[];
	readonly records: readonly TrainingRecord[];
	readonly evaluations: readonly BoundEvaluation[];
	readonly constraints?: readonly string[];
}

export interface EngineContext {
	readonly variables: Readonly<Record<string, string>>;
	readonly secrets?: SecretProvider;
	readonly signal?: AbortSignal;
}

export interface CandidateEdit {
	readonly artifactRef: string;
	readonly regionId: string;
	readonly startOffset: number;
	readonly endOffset: number;
	readonly replacement: string;
}

export interface CandidatePatch {
	readonly id: string;
	readonly trainableId: TrainableId;
	readonly engineId: string;
	readonly edits: readonly CandidateEdit[];
	readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Engines are async, provider-neutral adapters. */
export interface TrainingEngine {
	readonly id: string;
	optimize(request: OptimizeRequest, context: EngineContext): Promise<CandidatePatch>;
}

export async function optimizeCandidate(
	engine: TrainingEngine,
	request: OptimizeRequest,
	context: EngineContext,
): Promise<CandidatePatch> {
	validateRequest(request);
	const candidate = await engine.optimize(structuredClone(request), context);
	validateCandidate(candidate, request);
	return Object.freeze(structuredClone(candidate));
}

/** Apply a validated candidate only if every generated region is unchanged. */
export function applyCandidate(
	artifacts: Readonly<Record<string, string>>,
	candidate: CandidatePatch,
	regions: readonly GeneratedRegion[],
): Readonly<Record<string, string>> {
	const byId = uniqueRegions(regions);
	if (candidate.edits.length !== regions.length) {
		throw new Error("candidate must replace every requested region exactly once");
	}

	const seen = new Set<string>();
	const editsByArtifact = new Map<string, CandidateEdit[]>();
	for (const edit of candidate.edits) {
		const region = byId.get(edit.regionId);
		if (!region || seen.has(edit.regionId)) {
			throw new Error(`candidate contains an unknown or duplicate region: ${edit.regionId}`);
		}
		assertCompleteEdit(edit, region);
		const source = artifacts[region.artifactRef];
		if (source === undefined) {
			throw new Error(`artifact is missing: ${region.artifactRef}`);
		}
		if (digest(source.slice(region.startOffset, region.endOffset)) !== region.sourceDigest) {
			throw new Error(`generated region changed after optimization started: ${region.regionId}`);
		}
		seen.add(edit.regionId);
		const edits = editsByArtifact.get(edit.artifactRef) ?? [];
		edits.push(edit);
		editsByArtifact.set(edit.artifactRef, edits);
	}

	const result = { ...artifacts };
	for (const [artifactRef, edits] of editsByArtifact) {
		result[artifactRef] = [...edits]
			.sort((left, right) => right.startOffset - left.startOffset)
			.reduce(
				(source, edit) =>
					`${source.slice(0, edit.startOffset)}${matchTrailingNewline(source, edit)}${source.slice(edit.endOffset)}`,
				result[artifactRef] as string,
			);
	}
	return Object.freeze(result);
}

function validateRequest(request: OptimizeRequest): void {
	if (!request.objective.trim()) {
		throw new TypeError("optimization objective must be a non-empty string");
	}
	const regions = uniqueRegions(request.regions);
	if (regions.size === 0) {
		throw new TypeError("at least one generated region is required");
	}
	for (const region of regions.values()) {
		const source = request.artifacts[region.artifactRef];
		if (source === undefined) {
			throw new Error(`artifact is missing: ${region.artifactRef}`);
		}
		if (digest(source.slice(region.startOffset, region.endOffset)) !== region.sourceDigest) {
			throw new Error(`generated region is stale: ${region.regionId}`);
		}
	}
	if (request.records.some((record) => record.trainableId !== request.trainableId)) {
		throw new Error("training records must match the request trainable id");
	}
	if (request.evaluations.some((evaluation) => evaluation.trainableId !== request.trainableId)) {
		throw new Error("evaluations must match the request trainable id");
	}
}

function validateCandidate(candidate: CandidatePatch, request: OptimizeRequest): void {
	if (candidate.trainableId !== request.trainableId) {
		throw new Error("candidate must match the request trainable id");
	}
	if (!candidate.engineId.trim()) {
		throw new Error("candidate engine id must be a non-empty string");
	}
	if (candidate.edits.length !== request.regions.length) {
		throw new Error("candidate must replace every requested region exactly once");
	}
	const regions = uniqueRegions(request.regions);
	const seen = new Set<string>();
	for (const edit of candidate.edits) {
		const region = regions.get(edit.regionId);
		if (!region || seen.has(edit.regionId)) {
			throw new Error(`candidate contains an unknown or duplicate region: ${edit.regionId}`);
		}
		assertCompleteEdit(edit, region);
		seen.add(edit.regionId);
	}
}

function uniqueRegions(regions: readonly GeneratedRegion[]): Map<string, GeneratedRegion> {
	const byId = new Map(regions.map((region) => [region.regionId, region]));
	if (byId.size !== regions.length) {
		throw new Error("region ids must be unique");
	}
	return byId;
}

function assertCompleteEdit(edit: CandidateEdit, region: GeneratedRegion): void {
	if (
		edit.artifactRef !== region.artifactRef ||
		edit.startOffset !== region.startOffset ||
		edit.endOffset !== region.endOffset
	) {
		throw new Error(`candidate must replace the complete region: ${edit.regionId}`);
	}
}

function matchTrailingNewline(source: string, edit: CandidateEdit): string {
	const previous = source.slice(edit.startOffset, edit.endOffset);
	return previous.endsWith("\n") && !edit.replacement.endsWith("\n")
		? `${edit.replacement}\n`
		: edit.replacement;
}
