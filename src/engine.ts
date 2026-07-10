import { digest } from "./canonical.js";
import type { GeneratedRegion } from "./region.js";

export interface OptimizationRequest<Data = unknown> {
	/** Full source text keyed by each region's artifactRef. */
	readonly artifacts: Readonly<Record<string, string>>;
	readonly regions: readonly GeneratedRegion[];
	readonly data: Data;
}

export interface CandidateEdit {
	readonly artifactRef: string;
	readonly regionId: string;
	readonly startOffset: number;
	readonly endOffset: number;
	readonly replacement: string;
}

export interface RegionOptimizationSummary {
	readonly regionId: string;
	readonly bestScore: number;
	readonly optimizerType: string;
	readonly converged: boolean;
	readonly rounds: number;
}

export interface CandidatePatch {
	readonly id: string;
	readonly edits: readonly CandidateEdit[];
	readonly optimization: readonly RegionOptimizationSummary[];
}

/**
 * Apply a candidate only when every edit still covers its complete, unchanged
 * generated region. The input artifact map is never mutated.
 */
export function applyCandidate(
	artifacts: Readonly<Record<string, string>>,
	candidate: CandidatePatch,
	regions: readonly GeneratedRegion[],
): Readonly<Record<string, string>> {
	const byId = new Map(regions.map((region) => [region.regionId, region]));
	if (byId.size !== regions.length) {
		throw new Error("region ids must be unique");
	}
	const seen = new Set<string>();
	const editsByArtifact = new Map<string, CandidateEdit[]>();

	if (candidate.edits.length !== regions.length) {
		throw new Error("candidate must replace every requested region exactly once");
	}

	for (const edit of candidate.edits) {
		const region = byId.get(edit.regionId);
		if (!region || seen.has(edit.regionId)) {
			throw new Error(`candidate contains an unknown or duplicate region: ${edit.regionId}`);
		}
		if (
			edit.artifactRef !== region.artifactRef ||
			edit.startOffset !== region.startOffset ||
			edit.endOffset !== region.endOffset
		) {
			throw new Error(`candidate must replace the complete region: ${edit.regionId}`);
		}

		const source = artifacts[region.artifactRef];
		if (source === undefined) {
			throw new Error(`artifact is missing: ${region.artifactRef}`);
		}
		if (digest(source.slice(region.startOffset, region.endOffset)) !== region.sourceDigest) {
			throw new Error(`generated region changed after optimization started: ${region.regionId}`);
		}

		seen.add(edit.regionId);
		const artifactEdits = editsByArtifact.get(edit.artifactRef) ?? [];
		artifactEdits.push(edit);
		editsByArtifact.set(edit.artifactRef, artifactEdits);
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

function matchTrailingNewline(source: string, edit: CandidateEdit): string {
	const previous = source.slice(edit.startOffset, edit.endOffset);
	return previous.endsWith("\n") && !edit.replacement.endsWith("\n")
		? `${edit.replacement}\n`
		: edit.replacement;
}
