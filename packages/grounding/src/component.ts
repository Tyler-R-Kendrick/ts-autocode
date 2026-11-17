import { composeOptions, PENDING_GROUNDINGS, type PendingGrounding, type PendingMap, type GroundingOptions } from "./decorators.js";


export interface GroundingRegistry {
	has(methodRef: string): boolean;
	register(baseline: (input: unknown) => unknown, options: GroundingOptions): { readonly methodRef: string };
}

export const REGISTERED_METHODS = Symbol.for("ts-autocode.grounding.registered");

export function finalizeTrainableClass(
	cls: new () => object,
	metadata: Record<PropertyKey, unknown> | undefined,
	registry: GroundingRegistry,
	registeredSymbol: symbol = REGISTERED_METHODS,
): void {
	const pending =
		(metadata?.[PENDING_GROUNDINGS] as PendingMap | undefined) ?? new Map<string, PendingGrounding>();

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
	readonly intent: string;
}

export interface ComponentMetadata {
	readonly intent: string;
	readonly name: string;
	readonly operations: readonly string[];
}

export interface ComponentSymbols {
	readonly component: symbol;
	readonly operations: symbol;
}

export const COMPONENT_METADATA = Symbol.for("ts-autocode.component.metadata");

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

export function componentMetadataOf(cls: unknown, componentSymbol: symbol = COMPONENT_METADATA): ComponentMetadata | undefined {
	const metadataSymbol = (Symbol as { metadata?: symbol }).metadata;
	if (metadataSymbol === undefined) return undefined;
	const metadata = (cls as Record<symbol, Record<PropertyKey, unknown> | undefined> | undefined)?.[metadataSymbol];
	return metadata?.[componentSymbol] as ComponentMetadata | undefined;
}
