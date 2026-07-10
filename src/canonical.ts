import { createHash } from "node:crypto";

/**
 * Canonical JSON: keys sorted at every depth, two-space indent, trailing
 * newline. Two structurally equal values always serialize to the same bytes,
 * which is what makes candidate digests and replay digests byte-stable.
 */
export function canonicalJson(value: unknown): string {
	return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/** sha256 digest of the canonical JSON encoding, in `sha256:<hex>` form. */
export function digest(value: unknown): string {
	return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortKeys);
	}
	if (!isRecord(value)) {
		return value;
	}
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, sortKeys(value[key])]),
	);
}
