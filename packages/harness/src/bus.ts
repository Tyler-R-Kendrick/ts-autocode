import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

/** One message an actor writes to the bus. The bus attaches identity,
 * ordering, and time; it attaches no meaning — kinds and payloads are the
 * writers' vocabulary, not the bus's. */
export interface AgentMessage {
	readonly actor: string;
	readonly kind: string;
	readonly payload?: unknown;
}

export interface AgentBusEntry extends AgentMessage {
	readonly id: string;
	readonly sequence: number;
	readonly timestamp: string;
}

/** One requested bus operation, offered to the `allow` hook. */
export type AgentBusAccess =
	| Readonly<{ operation: "append"; actor: string; kind: string }>
	| Readonly<{ operation: "read"; actor?: string }>;

export interface AgentBusSettings {
	readonly file: string;
	readonly contextEntries?: number;
	readonly idFactory?: () => string;
	readonly now?: () => Date;
	readonly redact?: (value: unknown) => unknown;
	/** Decides whether an append or read may proceed; everything is allowed
	 * when unset. Refused operations throw. */
	readonly allow?: (access: AgentBusAccess) => boolean;
}

/** How many trailing bus entries `read()` returns when `contextEntries` is unset. */
export const defaultContextEntries = 100;

/** A durable append-only message log shared by the actors of a run. Writers
 * append before they act (hence write-ahead) and readers see the trailing
 * window, but the bus itself knows nothing about any actor: approval,
 * rejection, and every other protocol is just messages that some actor
 * chooses to write and others choose to read. */
export class WriteAheadAgentBus {
	readonly file: string;
	readonly #contextEntries: number;
	readonly #idFactory: () => string;
	readonly #now: () => Date;
	readonly #redact: (value: unknown) => unknown;
	readonly #allow: (access: AgentBusAccess) => boolean;
	#sequence = 0;
	#initialized = false;
	#pending: Promise<void> = Promise.resolve();

	constructor(settings: AgentBusSettings) {
		if (!isAbsolute(settings.file)) throw new TypeError("agent bus file must be absolute");
		const contextEntries = settings.contextEntries ?? defaultContextEntries;
		if (!Number.isInteger(contextEntries) || contextEntries < 1) {
			throw new TypeError("contextEntries must be a positive integer");
		}
		this.file = resolve(settings.file);
		this.#contextEntries = contextEntries;
		this.#idFactory = settings.idFactory ?? randomUUID;
		this.#now = settings.now ?? (() => new Date());
		this.#redact = settings.redact ?? ((value) => value);
		this.#allow = settings.allow ?? (() => true);
	}

	/** Durably appends one message and returns the recorded entry. */
	async append(message: AgentMessage): Promise<AgentBusEntry> {
		const actor = message.actor.trim();
		const kind = message.kind.trim();
		if (!actor) throw new TypeError("agent message actor must be non-empty");
		if (!kind) throw new TypeError("agent message kind must be non-empty");
		if (!this.#allow({ operation: "append", actor, kind })) {
			throw new Error(`agent bus refused append from ${actor}: ${kind}`);
		}
		const id = this.#idFactory().trim();
		if (!id) throw new TypeError("agent message id must be non-empty");
		let appended!: AgentBusEntry;
		const write = this.#pending.then(async () => {
			await mkdir(dirname(this.file), { recursive: true });
			if (!this.#initialized) {
				this.#sequence = await lastSequence(this.file);
				this.#initialized = true;
			}
			const entry: AgentBusEntry = Object.freeze({
				id,
				actor,
				kind,
				...(message.payload === undefined ? {} : { payload: this.#redact(message.payload) }),
				sequence: ++this.#sequence,
				timestamp: this.#now().toISOString(),
			});
			const handle = await open(this.file, "a");
			try {
				await handle.appendFile(`${safeJson(entry)}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			appended = entry;
		});
		this.#pending = write.catch(() => undefined);
		await write;
		return appended;
	}

	/** The trailing window of entries, optionally filtered to one actor. */
	async read(actor?: string): Promise<readonly AgentBusEntry[]> {
		if (!this.#allow({ operation: "read", ...(actor === undefined ? {} : { actor }) })) {
			throw new Error(`agent bus refused read${actor === undefined ? "" : ` of ${actor}`}`);
		}
		await this.#pending;
		let content: string;
		try {
			content = await readFile(this.file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const entries = parseEntries(content);
		const filtered = actor === undefined ? entries : entries.filter((entry) => entry.actor === actor);
		return Object.freeze(filtered.slice(-this.#contextEntries).map((entry) => Object.freeze(entry)));
	}
}

async function lastSequence(file: string): Promise<number> {
	try {
		const entries = parseEntries(await readFile(file, "utf8"));
		return entries.at(-1)?.sequence ?? 0;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
}

function parseEntries(content: string): AgentBusEntry[] {
	const lines = content.split("\n");
	const entries: AgentBusEntry[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]?.trim();
		if (!line) continue;
		try {
			entries.push(JSON.parse(line) as AgentBusEntry);
		} catch (error) {
			if (index !== lines.length - 1) throw error;
		}
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
