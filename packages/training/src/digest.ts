import { createHash } from "node:crypto";

/** Content addressing for discovered bodies and candidates. The algorithm —
 * sha256 over canonical (key-sorted, two-space, newline-terminated) JSON — is a
 * shared protocol with ts-autocode-rewrite: its guarded application refuses any
 * candidate whose target body digest no longer matches, so both packages must
 * digest identical content to identical values. */
export function digest(value: unknown): string {
	return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
	return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/** Plain objects only: class instances (Date, Map, Error, ...) fall through to
 * JSON.stringify so they are not silently canonicalized to `{}`. */
function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto: unknown = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
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
