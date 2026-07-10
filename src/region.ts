import { digest, isNonEmptyString } from "./canonical.js";

/**
 * A generated region is the only span of an artifact the optimizer may
 * rewrite. It is delimited in source by paired line markers:
 *
 *   // autocode:generated-region begin region=<regionId> owner=<owner>
 *   ...optimizer-owned code...
 *   // autocode:generated-region end region=<regionId>
 *
 * Everything outside the markers is hand-written and off limits.
 */
export interface GeneratedRegion {
	readonly regionId: string;
	/** Stable reference to the artifact the region lives in (e.g. a git URL + symbol). */
	readonly artifactRef: string;
	/** Offset of the first character after the begin-marker line. */
	readonly startOffset: number;
	/** Offset of the end marker; the region body is source.slice(startOffset, endOffset). */
	readonly endOffset: number;
	/** The principal that owns rewrites of this region (e.g. "training-engine"). */
	readonly owner: string;
}

/** A single replacement inside a generated region. */
export interface RegionEdit {
	readonly startOffset: number;
	readonly endOffset: number;
	readonly replacement: string;
}

export const DEFAULT_MARKER_PREFIX = "autocode:generated-region";

export interface RegionMarkerOptions {
	readonly artifactRef?: string;
	/** Marker token between `//` and `begin|end`; override to adopt existing markers (e.g. `hobo:generated-region`). */
	readonly markerPrefix?: string;
}

export class RegionError extends Error {
	readonly code: string;
	readonly path: string;

	constructor(code: string, path = "$", message = code) {
		super(`${code} at ${path}: ${message}`);
		this.name = "RegionError";
		this.code = code;
		this.path = path;
	}
}

/** Locates a marker-delimited generated region in `source`. */
export function findGeneratedRegion(
	source: string,
	regionId: string,
	{ artifactRef = "artifact://unknown", markerPrefix = DEFAULT_MARKER_PREFIX }: RegionMarkerOptions = {},
): GeneratedRegion {
	if (!isNonEmptyString(source)) {
		throw new RegionError("region.source_required", "$.source");
	}
	if (!isNonEmptyString(regionId)) {
		throw new RegionError("region.region_id_required", "$.regionId");
	}

	const beginPattern = new RegExp(
		`(^|\\n)(?<indent>\\s*)// ${escapeRegExp(markerPrefix)} begin region=${escapeRegExp(regionId)} owner=(?<owner>\\S+)`,
	);
	const begin = beginPattern.exec(source);
	if (!begin?.groups) {
		throw new RegionError("region.marker_missing", "$.source");
	}

	const beginLineEnd = source.indexOf("\n", begin.index + begin[0].length);
	if (beginLineEnd < 0) {
		throw new RegionError("region.marker_unclosed", "$.source");
	}

	const endMarker = `${begin.groups["indent"]}// ${markerPrefix} end region=${regionId}`;
	const endOffset = source.indexOf(endMarker, beginLineEnd + 1);
	if (endOffset < 0) {
		throw new RegionError("region.marker_unclosed", "$.source");
	}

	return {
		regionId,
		artifactRef,
		startOffset: beginLineEnd + 1,
		endOffset,
		owner: begin.groups["owner"] as string,
	};
}

export interface RegionDriftReport {
	readonly ok: boolean;
	readonly code: "region.generated_region_drift" | null;
	/** True when the hand-written code around the region differs between the two sources. */
	readonly handWrittenChanged: boolean;
	readonly expectedDigest?: string;
	readonly actualDigest?: string;
}

/**
 * Compares the generated region between the working source and the expected
 * (promoted) source. Drift inside the region means someone edited
 * optimizer-owned code by hand; changes outside the region are reported
 * separately and are legal.
 */
export function checkGeneratedRegionDrift({
	source,
	expectedSource,
	regionId,
	markerPrefix,
}: {
	source: string;
	expectedSource: string;
	regionId: string;
	markerPrefix?: string;
}): RegionDriftReport {
	const options = markerPrefix === undefined ? {} : { markerPrefix };
	const currentRegion = findGeneratedRegion(source, regionId, options);
	const expectedRegion = findGeneratedRegion(expectedSource, regionId, options);
	const currentRegionSource = source.slice(currentRegion.startOffset, currentRegion.endOffset);
	const expectedRegionSource = expectedSource.slice(expectedRegion.startOffset, expectedRegion.endOffset);
	const handWrittenChanged =
		withoutGeneratedRegion(source, currentRegion) !== withoutGeneratedRegion(expectedSource, expectedRegion);

	if (currentRegionSource === expectedRegionSource) {
		return { ok: true, code: null, handWrittenChanged };
	}

	return {
		ok: false,
		code: "region.generated_region_drift",
		handWrittenChanged,
		expectedDigest: digest(expectedRegionSource),
		actualDigest: digest(currentRegionSource),
	};
}

/** Applies edits to `source`, right-to-left so earlier offsets stay valid. */
export function applyRegionEdits(source: string, edits: readonly RegionEdit[]): string {
	return [...edits]
		.sort((left, right) => right.startOffset - left.startOffset)
		.reduce(
			(current, edit) => `${current.slice(0, edit.startOffset)}${edit.replacement}${current.slice(edit.endOffset)}`,
			source,
		);
}

function withoutGeneratedRegion(source: string, region: GeneratedRegion): string {
	return `${source.slice(0, region.startOffset)}<generated-region:${region.regionId}>${source.slice(region.endOffset)}`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
