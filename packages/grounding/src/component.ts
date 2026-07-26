import { composeOptions, legacyPendingFor, PENDING_GROUNDINGS, type PendingGrounding, type PendingMap, type GroundingOptions } from "./decorators.js";

// Class-level composition: a bare class decorator registers every
// granular-declared method (or every own method with fully inferred
// groundings) against a host-provided registry, and `component`-style
// metadata records the class's declared intent + operation refs. The
// registry and metadata symbols are parameters — this package never
// imports a training runtime, so any host (ts-autocode root, HoBo
// runtime, …) wires its own.

/** Host registry the class finalizer registers methods against. */
export interface GroundingRegistry {
	/** True when methodRef is already registered (first registration wins). */
	has(methodRef: string): boolean;
	/** Register a baseline callable under the composed grounding options. */
	register(baseline: (input: unknown) => unknown, options: GroundingOptions): { readonly methodRef: string };
}

/** Symbol under which registered methodRefs accumulate on class metadata. */
export const REGISTERED_METHODS = Symbol.for("ts-autocode.grounding.registered");

/**
 * Register every granular-declared method of a class (bare class
 * decorator). Methods with pending groundings are registered; when nothing
 * was annotated, every own prototype method is registered with fully
 * inferred groundings — the decorators are all optional. Baselines bind to
 * a lazily constructed instance (DI semantics; falls back to the prototype
 * for non-constructible classes).
 */
export function finalizeTrainableClass(
	cls: new () => object,
	metadata: Record<PropertyKey, unknown> | undefined,
	registry: GroundingRegistry,
	registeredSymbol: symbol = REGISTERED_METHODS,
): void {
	const pending =
		(metadata?.[PENDING_GROUNDINGS] as PendingMap | undefined) ??
		legacyPendingFor(cls.prototype) ??
		new Map<string, PendingGrounding>();

	const names =
		pending.size > 0
			? [...pending.keys()]
			: Object.getOwnPropertyNames(cls.prototype).filter(
					(name) =>
						name !== "constructor" && typeof (cls.prototype as Record<string, unknown>)[name] === "function",
				);

	let instance: object | undefined;
	const self = (): object => {
		if (!instance) {
			try {
				instance = new cls();
			} catch {
				instance = cls.prototype as object;
			}
		}
		return instance;
	};

	for (const name of names) {
		const methodRef = `${cls.name}.${name}`;
		if (registry.has(methodRef)) continue;
		const method = (cls.prototype as Record<string, unknown>)[name];
		if (typeof method !== "function") continue;
		const registered = registry.register(
			(input: unknown) => (method as (this: object, input: unknown) => unknown).call(self(), input),
			composeOptions(methodRef, pending.get(name)),
		);
		if (metadata) {
			const refs = (metadata[registeredSymbol] as string[] | undefined) ?? [];
			metadata[registeredSymbol] = [...refs, registered.methodRef];
		}
	}
}

export interface ComponentOptions {
	/** What the component is for — the component-level generation intent. */
	readonly intent: string;
}

export interface ComponentMetadata {
	readonly intent: string;
	readonly name: string;
	/** methodRefs of the component's declared operation methods. */
	readonly operations: readonly string[];
}

export interface ComponentSymbols {
	/** Where the finished ComponentMetadata lands on the class metadata. */
	readonly component: symbol;
	/** Where operation-method decorators accumulated their methodRefs. */
	readonly operations: symbol;
}

export const COMPONENT_METADATA = Symbol.for("ts-autocode.component.metadata");

/**
 * Build a `@component({ intent })` stage-3 class decorator over the given
 * metadata symbols. Operation-method decorators evaluate before the class
 * decorator, so the finished metadata is the component's full declaration:
 * intent + operation refs.
 */
export function createComponentDecorator(symbols: ComponentSymbols) {
	return function component(options: ComponentOptions): <
		C extends abstract new (
			...args: never[]
		) => object,
	>(
		cls: C,
		context: ClassDecoratorContext<C>,
	) => void {
		return (cls, context) => {
			if (!context.metadata) return;
			const operations = (context.metadata[symbols.operations] as string[] | undefined) ?? [];
			context.metadata[symbols.component] = Object.freeze({
				intent: options.intent,
				name: String(context.name ?? cls.name),
				operations: Object.freeze([...operations]),
			}) satisfies ComponentMetadata;
		};
	};
}

/** Read a decorated class's component metadata (undefined when not one). */
export function componentMetadataOf(cls: unknown, componentSymbol: symbol = COMPONENT_METADATA): ComponentMetadata | undefined {
	const metadataSymbol = (Symbol as { metadata?: symbol }).metadata;
	if (metadataSymbol === undefined) return undefined;
	const metadata = (cls as Record<symbol, Record<PropertyKey, unknown> | undefined> | undefined)?.[metadataSymbol];
	return metadata?.[componentSymbol] as ComponentMetadata | undefined;
}
