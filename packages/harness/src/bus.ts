import { randomUUID } from "node:crypto";

import { createStorage, type Storage } from "unstorage";

import { agentBusEntry, agentMessage, messageId, type AgentBusEntry, type AgentMessage } from "./schema.js";

/** One requested bus operation, offered to the `allow` hook. */
export type AgentBusAccess =
	| Readonly<{ operation: "append"; actor: string; kind: string }>
	| Readonly<{ operation: "read"; actor?: string }>;

/** Entries live under this key prefix in the configured storage. */
const entryPrefix = "entry";

export interface AgentBusSettings {
	/** Where entries live: any [unstorage](https://unstorage.unjs.io) instance
	 * — the driver (memory, fs, redis, http, ...) is the consumer's choice.
	 * In-memory storage when unset. A bus expects sole write access to its
	 * `entry:*` keys; share a wider storage by mounting or prefixing it. */
	readonly storage?: Storage;
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
	readonly #storage: Storage;
	readonly #idFactory: () => string;
	readonly #now: () => Date;
	readonly #redact: (value: unknown) => unknown;
	readonly #allow: (access: AgentBusAccess) => boolean;
	#sequence: number | undefined;
	#pending: Promise<void> = Promise.resolve();

	constructor(settings: AgentBusSettings = {}) {
		this.#storage = settings.storage ?? createStorage();
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
			// Sequence numbering resumes from whatever the storage already holds.
			this.#sequence ??= (await this.#load()).at(-1)?.sequence ?? 0;
			const entry = Object.freeze(agentBusEntry.parse({
				actor: parsed.actor,
				kind: parsed.kind,
				...(parsed.payload === undefined ? {} : { payload: this.#redact(parsed.payload) }),
				id,
				sequence: this.#sequence + 1,
				timestamp: this.#now().toISOString(),
			}));
			await this.#storage.setItem(`${entryPrefix}:${entry.sequence}`, entry);
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
		const entries = await this.#load();
		return Object.freeze(actor === undefined ? entries : entries.filter((entry) => entry.actor === actor));
	}

	async #load(): Promise<AgentBusEntry[]> {
		const keys = await this.#storage.getKeys(entryPrefix);
		const items = await this.#storage.getItems(keys);
		return items
			.map(({ value }) => agentBusEntry.parse(value))
			.sort((first, second) => first.sequence - second.sequence);
	}
}
