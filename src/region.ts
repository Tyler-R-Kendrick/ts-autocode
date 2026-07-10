import { digest, isNonEmptyString } from "./canonical.js";

const markerPrefix = "autocode:generated-region";

/** A source range that an optimizer is allowed to replace. */
export interface GeneratedRegion {
	readonly regionId: string;
	readonly artifactRef: string;
	readonly startOffset: number;
	readonly endOffset: number;
	readonly owner: string;
	/** Digest of the region body when it was discovered. */
	readonly sourceDigest: string;
}

export interface RegionMarkerOptions {
	readonly artifactRef?: string;
	readonly markerPrefix?: string;
}

/** Find a generated region and freeze the source digest used for stale-write checks. */
export function findGeneratedRegion(
	source: string,
	regionId: string,
	options: RegionMarkerOptions = {},
): GeneratedRegion {
	if (!isNonEmptyString(source)) {
		throw new TypeError("source must be a non-empty string");
	}
	if (!isNonEmptyString(regionId)) {
		throw new TypeError("regionId must be a non-empty string");
	}

	const prefix = options.markerPrefix ?? markerPrefix;
	const begin = new RegExp(
		`(^|\\n)(?<indent>\\s*)// ${escapeRegExp(prefix)} begin region=${escapeRegExp(regionId)} owner=(?<owner>\\S+)`,
	).exec(source);
	if (!begin?.groups) {
		throw new Error(`generated region ${regionId} was not found`);
	}

	const startOffset = source.indexOf("\n", begin.index + begin[0].length) + 1;
	if (startOffset === 0) {
		throw new Error(`generated region ${regionId} has no body`);
	}

	const endMarker = `${begin.groups["indent"]}// ${prefix} end region=${regionId}`;
	const endOffset = source.indexOf(endMarker, startOffset);
	if (endOffset < 0) {
		throw new Error(`generated region ${regionId} is not closed`);
	}

	return Object.freeze({
		regionId,
		artifactRef: options.artifactRef ?? "memory://source",
		startOffset,
		endOffset,
		owner: begin.groups["owner"] as string,
		sourceDigest: digest(source.slice(startOffset, endOffset)),
	});
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
