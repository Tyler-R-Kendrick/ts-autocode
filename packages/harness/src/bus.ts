import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
	absolutePath,
	agentBusEntry,
	agentMessage,
	messageId,
	type AbsolutePath,
	type AgentBusEntry,
	type AgentMessage,
} from "./schema.js";

/** One requested bus operation, offered to the `allow` hook. */
export type AgentBusAccess =
	| Readonly<{ operation: "append"; actor: string; kind: string }>
	| Readonly<{ operation: "read"; actor?: string }>;

/** Ordered storage for bus entries. Implementations may keep entries in
 * memory, on disk, or behind a remote service — the bus does not care, and
 * any object with these two methods plugs in. A store belongs to one writing
 * bus at a time: the bus resumes sequence numbering from the store's tail and
 * then owns it, so concurrent writers need a store with its own reservation
 * semantics behind this interface. */
export interface AgentBusStore {
	/** Appends one entry, preserving sequence order. */
	append(entry: AgentBusEntry): Promise<void>;
	/** Every stored entry, in sequence order. */
	load(): Promise<readonly AgentBusEntry[]>;
}

export interface AgentBusSettings {
	/** Where entries live; volatile in-memory storage when unset. */
	readonly store?: AgentBusStore;
	readonly idFactory?: () => string;
	readonly now?: () => Date;
	readonly redact?: (value: unknown) => unknown;
	/** Decides whether an append or read may proceed; everything is allowed
	 * when unset. Refused operations throw. */
	readonly allow?: (access: AgentBusAccess) => boolean;
}

/** An ordered message log shared by the actors of a run. Writers append
 * before they act (hence write-ahead) and readers see the full history, but
 * the bus itself knows nothing about any actor and does no context
 * management: approval, rejection, windowing, and summarizing are all the
 * concern of whoever writes and reads. */
export class WriteAheadAgentBus {
	readonly #store: AgentBusStore;
	readonly #idFactory: () => string;
	readonly #now: () => Date;
	readonly #redact: (value: unknown) => unknown;
	readonly #allow: (access: AgentBusAccess) => boolean;
	#sequence: number | undefined;
	#pending: Promise<void> = Promise.resolve();

	constructor(settings: AgentBusSettings = {}) {
		this.#store = settings.store ?? createMemoryBusStore();
		this.#idFactory = settings.idFactory ?? randomUUID;
		this.#now = settings.now ?? (() => new Date());
		this.#redact = settings.redact ?? ((value) => value);
		this.#allow = settings.allow ?? (() => true);
	}

	/** Appends one message and returns the recorded entry. */
	async append(message: AgentMessage): Promise<AgentBusEntry> {
		const parsed = agentMessage.parse(message);
		if (!this.#allow({ operation: "append", actor: parsed.actor, kind: parsed.kind })) {
			throw new Error(`agent bus refused append from ${parsed.actor}: ${parsed.kind}`);
		}
		const id = messageId.parse(this.#idFactory());
		let appended!: AgentBusEntry;
		const write = this.#pending.then(async () => {
			// Sequence numbering resumes from whatever the store already holds.
			this.#sequence ??= (await this.#store.load()).at(-1)?.sequence ?? 0;
			const entry = Object.freeze(agentBusEntry.parse({
				actor: parsed.actor,
				kind: parsed.kind,
				...(parsed.payload === undefined ? {} : { payload: this.#redact(parsed.payload) }),
				id,
				sequence: this.#sequence + 1,
				timestamp: this.#now().toISOString(),
			}));
			await this.#store.append(entry);
			this.#sequence += 1;
			appended = entry;
		});
		this.#pending = write.catch(() => undefined);
		await write;
		return appended;
	}

	/** Every entry in order, optionally filtered to one actor. */
	async read(actor?: string): Promise<readonly AgentBusEntry[]> {
		if (!this.#allow({ operation: "read", ...(actor === undefined ? {} : { actor }) })) {
			throw new Error(`agent bus refused read${actor === undefined ? "" : ` of ${actor}`}`);
		}
		await this.#pending;
		const entries = await this.#store.load();
		return Object.freeze(actor === undefined ? [...entries] : entries.filter((entry) => entry.actor === actor));
	}
}

/** Volatile in-memory storage: the default when no store is configured. */
export function createMemoryBusStore(): AgentBusStore {
	const entries: AgentBusEntry[] = [];
	return {
		append: async (entry) => {
			entries.push(entry);
		},
		load: async () => [...entries],
	};
}

export interface FileBusStore extends AgentBusStore {
	/** Resolved absolute path of the JSONL log. */
	readonly file: AbsolutePath;
}

/** Durable JSONL storage, fsynced per append. On load, an incomplete trailing
 * line (a crashed writer) is ignored; anything else that fails to parse as an
 * entry is an error rather than silently accepted. */
export function createFileBusStore(file: string): FileBusStore {
	const path = absolutePath.parse(file);
	return {
		file: path,
		append: async (entry) => {
			await mkdir(dirname(path), { recursive: true });
			const handle = await open(path, "a");
			try {
				await handle.appendFile(`${safeJson(entry)}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
		},
		load: async () => {
			let content: string;
			try {
				content = await readFile(path, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
				throw error;
			}
			return parseEntries(content);
		},
	};
}

function parseEntries(content: string): AgentBusEntry[] {
	const lines = content.split("\n");
	const entries: AgentBusEntry[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]?.trim();
		if (!line) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch (error) {
			// Only an incomplete trailing fragment (a crashed writer) is
			// recoverable; a complete record that fails the schema is not.
			if (index === lines.length - 1) continue;
			throw error;
		}
		entries.push(agentBusEntry.parse(value));
	}
	return entries;
}

function safeJson(value: unknown): string {
	const seen = new WeakSet<object>();
	return JSON.stringify(value, (_key, item: unknown) => {
		if (typeof item === "bigint") return item.toString();
		if (!item || typeof item !== "object") return item;
		if (seen.has(item)) return "[Circular]";
		seen.add(item);
		return item;
	});
}
