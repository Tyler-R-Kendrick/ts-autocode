import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Volume } from "memfs";

import type { AgentBusStore } from "./bus.js";
import { absolutePath, agentBusEntry, type AbsolutePath, type AgentBusEntry } from "./schema.js";

/** The slice of `node:fs/promises` the store writes through — the TypeScript
 * ecosystem's standard filesystem seam, in the spirit of C#'s `IFileProvider`
 * or Python's fsspec. `node:fs/promises` itself, a memfs volume's `.promises`,
 * or any compatible implementation (ZenFS and friends for remote backends)
 * plugs in unchanged. */
export interface BusFileSystem {
	mkdir(path: string, options: { readonly recursive: true }): Promise<unknown>;
	readFile(path: string, encoding: "utf8"): Promise<string | Uint8Array>;
	open(path: string, flags: "a"): Promise<{
		appendFile(data: string, encoding: "utf8"): Promise<unknown>;
		/** Flush to durable storage; optional because purely virtual
		 * filesystems (memfs types, notably) have nothing to flush. */
		sync?(): Promise<unknown>;
		close(): Promise<unknown>;
	}>;
}

const localFileSystem: BusFileSystem = { mkdir, open, readFile };

/** Append-only JSONL storage over an injected filesystem — as durable as that
 * filesystem is, since each append goes through a synced handle. On load, an
 * incomplete trailing JSON fragment (a crashed writer) is ignored; a complete
 * record that fails the entry schema is an error rather than silently
 * accepted. */
export class JsonlBusStore implements AgentBusStore {
	/** Resolved absolute path of the JSONL log. */
	readonly file: AbsolutePath;
	readonly #filesystem: BusFileSystem;

	constructor(file: string, filesystem: BusFileSystem = localFileSystem) {
		this.file = absolutePath.parse(file);
		this.#filesystem = filesystem;
	}

	/** A store over a fresh in-memory filesystem (a memfs volume): what a bus
	 * uses when it is given no store. */
	static inMemory(file = "/agent-bus.jsonl"): JsonlBusStore {
		return new JsonlBusStore(file, new Volume().promises);
	}

	async append(entry: AgentBusEntry): Promise<void> {
		await this.#filesystem.mkdir(dirname(this.file), { recursive: true });
		const handle = await this.#filesystem.open(this.file, "a");
		try {
			await handle.appendFile(`${serialize(entry)}\n`, "utf8");
			await handle.sync?.();
		} finally {
			await handle.close();
		}
	}

	async load(): Promise<readonly AgentBusEntry[]> {
		let content: string | Uint8Array;
		try {
			content = await this.#filesystem.readFile(this.file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		return parse(typeof content === "string" ? content : new TextDecoder().decode(content));
	}
}

function parse(content: string): AgentBusEntry[] {
	const lines = content.split("\n");
	const entries: AgentBusEntry[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]?.trim();
		if (!line) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch (error) {
			if (index === lines.length - 1) continue;
			throw error;
		}
		entries.push(agentBusEntry.parse(value));
	}
	return entries;
}

function serialize(value: unknown): string {
	const seen = new WeakSet<object>();
	return JSON.stringify(value, (_key, item: unknown) => {
		if (typeof item === "bigint") return item.toString();
		if (!item || typeof item !== "object") return item;
		if (seen.has(item)) return "[Circular]";
		seen.add(item);
		return item;
	});
}
