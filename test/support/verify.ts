import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "vitest";


const snapshotDirectory = new URL("../snapshots/", import.meta.url);

export interface Scrubbers {
	readonly paths?: Readonly<Record<string, string>>;
	readonly replace?: ReadonlyArray<readonly [RegExp, string]>;
}

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

export async function verify(name: string, value: string, scrubbers?: Scrubbers): Promise<void> {
	const file = fileFor(name);
	recordVerified(file);
	await expect(scrub(value, scrubbers)).toMatchFileSnapshot(file);
}

const markerDirectory = fileURLToPath(new URL("../output/verified/", import.meta.url));

function recordVerified(file: string): void {
	try {
		mkdirSync(markerDirectory, { recursive: true });
		writeFileSync(join(markerDirectory, createHash("sha256").update(file).digest("hex")), file, "utf8");
	} catch {
	}
}

export function fileFor(name: string): string {
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const extension = dot > 0 ? name.slice(dot) : ".txt";
	return fileURLToPath(new URL(`${stem}.verified${extension}`, snapshotDirectory));
}

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
