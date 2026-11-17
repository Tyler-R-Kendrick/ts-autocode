export type Marker = `use ${string}`;

export interface InstrumentTarget {
	readonly id: string;
	readonly methodName: string;
	readonly className?: string;
}

export type InstrumentEntry =
	| { readonly id: string; readonly name: string; readonly owner: () => unknown }
	| { readonly id: string; readonly get: () => unknown; readonly set: (fn: unknown) => void };

export type InstrumentRegistry = (entries: readonly InstrumentEntry[]) => void;

export interface Instrumentation {
	method(owner: abstract new (...args: never[]) => unknown, methodName: string, id: string): void;
	wrap<F extends (...args: never[]) => unknown>(fn: F, id: string): F;
}

export const instrumentKey = "ts-autocode.instrument";

const registrySlot = Symbol.for(instrumentKey);

export function installInstrumentation(handlers: Instrumentation): void {
	const registry: InstrumentRegistry = (entries) => {
		if (!Array.isArray(entries)) return;
		for (const entry of entries) {
			try {
				registerEntry(handlers, entry);
			} catch {
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
