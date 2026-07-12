/** A `"use <name>"` directive; compile-time mirror of `normalizeMarker`'s runtime rule. */
export type Marker = `use ${string}`;

/** Any discovery that names a method (and optionally its class) can drive
 * instrumentation with these fields. */
export interface InstrumentTarget {
	readonly id: string;
	readonly methodName: string;
	readonly className?: string;
}

/** Runtime payload delivered by generated registrations: identifier accessors in
 * place of identifier names. Method entries carry `owner`; free-function entries
 * carry `get`/`set` — the discriminator is structural, mirroring InstrumentTarget. */
export type InstrumentEntry =
	| { readonly id: string; readonly name: string; readonly owner: () => unknown }
	| { readonly id: string; readonly get: () => unknown; readonly set: (fn: unknown) => void };

/** The function generated code calls once per module with its entries. */
export type InstrumentRegistry = (entries: readonly InstrumentEntry[]) => void;

/** What the runtime does with a discovered target; consumers supply their own
 * idempotent method and free-function handlers here. */
export interface Instrumentation {
	method(owner: abstract new (...args: never[]) => unknown, methodName: string, id: string): void;
	wrap<F extends (...args: never[]) => unknown>(fn: F, id: string): F;
}

export const instrumentKey = "ts-autocode.instrument";

const registrySlot = Symbol.for(instrumentKey);

/** Installs the guarded interpreter for generated registrations at
 * `globalThis[Symbol.for(instrumentKey)]`. Every guard lives here rather than in
 * generated text: entries resolve their accessors lazily, non-functions are
 * skipped, and a failing entry can never break module evaluation. */
export function installInstrumentation(handlers: Instrumentation): void {
	const registry: InstrumentRegistry = (entries) => {
		if (!Array.isArray(entries)) return;
		for (const entry of entries) {
			try {
				registerEntry(handlers, entry);
			} catch {
				// Instrumentation is best-effort; the module must still load.
			}
		}
	};
	(globalThis as Record<symbol, unknown>)[registrySlot] = Object.freeze(Object.assign(registry, { handlers }));
}

export function installedInstrumentation(): Instrumentation | undefined {
	const registry = (globalThis as Record<symbol, unknown>)[registrySlot];
	return typeof registry === "function" ? (registry as { handlers?: Instrumentation }).handlers : undefined;
}

function registerEntry(handlers: Instrumentation, entry: InstrumentEntry): void {
	if ("owner" in entry) {
		const owner = entry.owner();
		if (typeof owner === "function") {
			handlers.method(owner as abstract new (...args: never[]) => unknown, entry.name, entry.id);
		}
		return;
	}
	const fn = entry.get();
	if (typeof fn === "function") {
		entry.set(handlers.wrap(fn as (...args: never[]) => unknown, entry.id));
	}
}
