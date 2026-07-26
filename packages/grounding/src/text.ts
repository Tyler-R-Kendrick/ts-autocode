import { createHash } from "node:crypto";

// Deterministic text/JSON helpers for codegen pipelines. Outputs are pinned
// by golden tests so downstream byte-for-byte digest parity holds.

/** Deterministic two-space JSON: keys sorted, arrays/sets/maps normalized. */
export function stableStringify(value: unknown): string {
	return `${JSON.stringify(toStableValue(value), null, 2)}\n`;
}

export function toStableValue(value: unknown): unknown {
	if (value instanceof Map) {
		return Object.fromEntries(
			[...value.entries()]
				.map(([key, entry]) => [String(key), toStableValue(entry)] as const)
				.sort(([left], [right]) => left.localeCompare(right)),
		);
	}

	if (value instanceof Set) {
		return [...value].map(toStableValue).sort(stableCompare);
	}

	if (Array.isArray(value)) {
		return value.map(toStableValue).sort(stableCompare);
	}

	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.map(([key, entry]) => [key, toStableValue(entry)] as const)
				.sort(([left], [right]) => left.localeCompare(right)),
		);
	}

	return value;
}

function stableCompare(left: unknown, right: unknown): number {
	return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

/** LF-only, no trailing intra-line whitespace, exactly one final newline. */
export function normalizeText(value: string): string {
	return `${value
		.replace(/\r\n/g, "\n")
		.replace(/[ \t]+$/gm, "")
		.replace(/\s+$/u, "")}\n`;
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/");
}

export function digest(value: string): string {
	return `sha256:${createHash("sha256").update(normalizeText(value), "utf8").digest("hex")}`;
}

export function pascalCase(value: string): string {
	return value
		.split(/[^a-zA-Z0-9]+/)
		.filter(Boolean)
		.map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
		.join("");
}

export function camelCase(value: string): string {
	const parts = value.split(/[^a-zA-Z0-9]+/).filter(Boolean);
	return parts
		.map((part, index) =>
			index === 0 ? part.charAt(0).toLowerCase() + part.slice(1) : part.charAt(0).toUpperCase() + part.slice(1),
		)
		.join("");
}

/** A sorted string-literal union type expression, or `never` when empty. */
export function union(values: readonly string[]): string {
	const entries = [...values].sort();
	return entries.length > 0 ? entries.map((value) => JSON.stringify(value)).join(" | ") : "never";
}
