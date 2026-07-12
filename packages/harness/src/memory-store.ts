import type { AgentBusStore } from "./bus.js";
import type { AgentBusEntry } from "./schema.js";

/** Volatile in-memory storage: the default when a bus gets no store. */
export class MemoryBusStore implements AgentBusStore {
	readonly #entries: AgentBusEntry[] = [];

	async append(entry: AgentBusEntry): Promise<void> {
		this.#entries.push(entry);
	}

	async load(): Promise<readonly AgentBusEntry[]> {
		return [...this.#entries];
	}
}
