import { fileURLToPath } from "node:url";

import { expect } from "vitest";

// A Verify-style characterization helper (https://github.com/VerifyTests/Verify).
//
// Vitest's inline `toMatchSnapshot` hides the approved value inside a `.snap`
// blob keyed by test name, which makes a diff hard to read and a rename silently
// orphan the snapshot. Verify's model is better for characterizing generated
// text: one named file per subject, committed and reviewed like any other
// artifact, so a diff in a pull request shows exactly what the generator's
// output became.
//
// `test/snapshots/<name>.verified.<ext>` is the approved value. A mismatch fails
// and Vitest writes the received value beside it; `npm test -- -u` approves.

const snapshotDirectory = new URL("../snapshots/", import.meta.url);

/** Values that would make a snapshot churn between machines or runs. */
export interface Scrubbers {
	/** Absolute paths to replace with a stable placeholder. */
	readonly paths?: Readonly<Record<string, string>>;
	/** Extra replacements applied in order. */
	readonly replace?: ReadonlyArray<readonly [RegExp, string]>;
}

/** Removes machine- and run-specific detail so a snapshot means the same thing
 * everywhere. A snapshot that churns is a snapshot everyone learns to re-approve
 * without reading, which defeats the point. */
export function scrub(value: string, scrubbers: Scrubbers = {}): string {
	let text = value;
	for (const [absolute, placeholder] of Object.entries(scrubbers.paths ?? {})) {
		text = text.split(absolute).join(placeholder);
	}
	text = text
		.replace(/sha256:[0-9a-f]{64}/g, "sha256:<digest>")
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>")
		.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<timestamp>")
		.replace(/\r\n/g, "\n");
	for (const [pattern, replacement] of scrubbers.replace ?? []) {
		text = text.replace(pattern, replacement);
	}
	return text.trimEnd() + "\n";
}

/** Compare `value` against the approved snapshot named `name`. */
export async function verify(name: string, value: string, scrubbers?: Scrubbers): Promise<void> {
	await expect(scrub(value, scrubbers)).toMatchFileSnapshot(fileFor(name));
}

/** Approved-snapshot path for a subject name. `a/b.ts` keeps its extension so
 * editors syntax-highlight the snapshot. */
export function fileFor(name: string): string {
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const extension = dot > 0 ? name.slice(dot) : ".txt";
	return fileURLToPath(new URL(`${stem}.verified${extension}`, snapshotDirectory));
}

/** Characterize a JSON-serializable value with stable key ordering. */
export async function verifyJson(name: string, value: unknown, scrubbers?: Scrubbers): Promise<void> {
	await verify(`${name}.json`, `${JSON.stringify(sortKeys(value), null, 2)}\n`, scrubbers);
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (typeof value !== "object" || value === null) return value;
	if (Object.getPrototypeOf(value) !== Object.prototype) return value;
	return Object.fromEntries(
		Object.keys(value as Record<string, unknown>).sort()
			.map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
	);
}
