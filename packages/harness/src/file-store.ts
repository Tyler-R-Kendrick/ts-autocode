import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { AgentBusStore } from "./bus.js";
import { absolutePath, agentBusEntry, type AbsolutePath, type AgentBusEntry } from "./schema.js";

/** Durable JSONL storage, fsynced per append. On load, an incomplete trailing
 * JSON fragment (a crashed writer) is ignored; a complete record that fails
 * the entry schema is an error rather than silently accepted. */
export class FileBusStore implements AgentBusStore {
	/** Resolved absolute path of the JSONL log. */
	readonly file: AbsolutePath;

	constructor(file: string) {
		this.file = absolutePath.parse(file);
	}

	async append(entry: AgentBusEntry): Promise<void> {
		await mkdir(dirname(this.file), { recursive: true });
		const handle = await open(this.file, "a");
		try {
			await handle.appendFile(`${serialize(entry)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	async load(): Promise<readonly AgentBusEntry[]> {
		let content: string;
		try {
			content = await readFile(this.file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		return parse(content);
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
