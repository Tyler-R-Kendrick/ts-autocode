import { randomUUID } from "node:crypto";

import { MemoryBusStore } from "./memory-store.js";
import { agentBusEntry, agentMessage, messageId, type AgentBusEntry, type AgentMessage } from "./schema.js";

/** One requested bus operation, offered to the `allow` hook. */
export type AgentBusAccess =
	| Readonly<{ operation: "append"; actor: string; kind: string }>
	| Readonly<{ operation: "read"; actor?: string }>;

/** Ordered storage for bus entries. Implementations may keep entries in
 * memory, on disk, or behind a remote service — the bus does not care. A
 * store belongs to one writing bus at a time: the bus resumes sequence
 * numbering from the store's tail and then owns it, so concurrent writers
 * need a store with its own reservation semantics behind this interface. */
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
		this.#store = settings.store ?? new MemoryBusStore();
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
