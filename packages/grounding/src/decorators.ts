// Granular grounding decorators: @intent / @returns on methods and
// @description on parameters annotate an implementation one fact at a
// time — every decorator optional, every missing grounding inferred. A
// class-level finalizer (see component.ts) composes whatever was declared
// into GroundingOptions and registers each method with a host-provided
// registry.
//
// Every decorator here is DUAL-MODE: it detects at call time whether it
// was invoked with TC39 stage-3 semantics (value, context) or legacy
// `experimentalDecorators` semantics (target, key, descriptor/index).
// Stage-3 has no parameter decorators — @description in parameter position
// only compiles in projects that opt into legacy decorators; stage-3 users
// pass the same object through `params:` maps.

/** A parameter or output annotation. */
export interface FieldDescription {
	readonly description: string;
	readonly example?: unknown;
}

/** Provider-neutral composed grounding for one method. */
export interface GroundingOptions {
	readonly methodRef: string;
	readonly intent: string;
	readonly contract: { readonly ref: string };
	readonly params?: Record<string, FieldDescription>;
	readonly output?: { readonly returns: FieldDescription };
}

export interface PendingGrounding {
	intent?: string;
	returns?: string;
	params?: Record<string, FieldDescription>;
}

export type PendingMap = Map<string, PendingGrounding>;

/** Stage-3: pending groundings ride the class's `Symbol.metadata` record. */
export const PENDING_GROUNDINGS = Symbol.for("ts-autocode.grounding.pending");

/** Legacy: pending groundings keyed by the class prototype. */
const legacyPending = new WeakMap<object, PendingMap>();

/** Read the legacy pending map for a prototype (undefined when none). */
export function legacyPendingFor(prototype: object): PendingMap | undefined {
	return legacyPending.get(prototype);
}

function stage3Pending(metadata: Record<PropertyKey, unknown>): PendingMap {
	const existing = metadata[PENDING_GROUNDINGS] as PendingMap | undefined;
	if (existing) return existing;
	const created: PendingMap = new Map();
	metadata[PENDING_GROUNDINGS] = created;
	return created;
}

function pendingEntry(map: PendingMap, method: string): PendingGrounding {
	const existing = map.get(method);
	if (existing) return existing;
	const created: PendingGrounding = {};
	map.set(method, created);
	return created;
}

interface Stage3MethodContext {
	readonly kind: string;
	readonly name: string | symbol;
	readonly metadata?: Record<PropertyKey, unknown>;
}

function isStage3MethodContext(value: unknown): value is Stage3MethodContext {
	return typeof value === "object" && value !== null && "kind" in value && "name" in value;
}

function methodPending(args: readonly unknown[]): { entry: PendingGrounding; passthrough: unknown } | undefined {
	const [first, second, third] = args;
	if (isStage3MethodContext(second)) {
		// Stage-3: (method, context). Metadata may be absent in exotic hosts.
		if (!second.metadata) return undefined;
		return {
			entry: pendingEntry(stage3Pending(second.metadata), String(second.name)),
			passthrough: first,
		};
	}
	if ((typeof second === "string" || typeof second === "symbol") && typeof first === "object" && first !== null) {
		// Legacy: (prototype, propertyKey, descriptor).
		let map = legacyPending.get(first);
		if (!map) {
			map = new Map();
			legacyPending.set(first, map);
		}
		return {
			entry: pendingEntry(map, String(second)),
			passthrough: third,
		};
	}
	return undefined;
}

/** `@intent("…")` — the method's generation intent. Optional; inferred when absent. */
export function intent(text: string) {
	return (...args: unknown[]): unknown => {
		const pending = methodPending(args);
		if (pending) pending.entry.intent = text;
		return pending?.passthrough;
	};
}

/** `@returns("…")` — describes the output. Optional; lowers to output field metadata. */
export function returns(text: string) {
	return (...args: unknown[]): unknown => {
		const pending = methodPending(args);
		if (pending) pending.entry.returns = text;
		return pending?.passthrough;
	};
}

/**
 * `@description("…")` — per-parameter annotation. In legacy
 * `experimentalDecorators` projects this is a real parameter decorator
 * (the parameter's name is recovered from the method source, falling back
 * to `arg<index>`); under stage-3 (no parameter decorators in TC39) the
 * SAME call doubles as a `FieldDescription` value for `params:` maps —
 * `params: { name: description("…") }`.
 */
export function description(text: string, example?: unknown): FieldDescription & ((...args: unknown[]) => void) {
	const legacyParamDecorator = (...args: unknown[]): void => {
		const [target, key, index] = args;
		if (
			typeof target !== "object" ||
			target === null ||
			(typeof key !== "string" && typeof key !== "symbol") ||
			typeof index !== "number"
		) {
			return;
		}
		let map = legacyPending.get(target);
		if (!map) {
			map = new Map();
			legacyPending.set(target, map);
		}
		const entry = pendingEntry(map, String(key));
		const method = (target as Record<string, unknown>)[String(key)];
		const name = parameterName(method, index) ?? `arg${index}`;
		entry.params = {
			...entry.params,
			[name]: example === undefined ? { description: text } : { description: text, example },
		};
	};
	Object.defineProperty(legacyParamDecorator, "description", { value: text });
	if (example !== undefined) {
		Object.defineProperty(legacyParamDecorator, "example", { value: example });
	}
	return legacyParamDecorator as FieldDescription & ((...args: unknown[]) => void);
}

/**
 * `param(description, example?)` — per-parameter annotation for the
 * `params`/`output` maps of grounding options. Stage-3 decorators have no
 * parameter decorators, so parameter metadata rides the options object;
 * this helper keeps the declaration one expression per parameter.
 */
export function param(text: string, example?: unknown): FieldDescription {
	return example === undefined ? Object.freeze({ description: text }) : Object.freeze({ description: text, example });
}

/** Best-effort parameter-name recovery from the method source. */
function parameterName(method: unknown, index: number): string | undefined {
	if (typeof method !== "function") return undefined;
	const source = String(method);
	const open = source.indexOf("(");
	if (open < 0) return undefined;
	let depth = 0;
	let end = open;
	for (let i = open; i < source.length; i += 1) {
		if (source[i] === "(") depth += 1;
		if (source[i] === ")") {
			depth -= 1;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	const params = source
		.slice(open + 1, end)
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	const param = params[index];
	if (!param) return undefined;
	const match = param.match(/^[{[]?\s*(\w+)/);
	return match?.[1];
}

/** Inferred intent for a method that declared none (all decorators optional). */
export function inferredIntent(methodRef: string): string {
	return `Inferred: implement ${methodRef} to satisfy its declared signature and descriptions.`;
}

export function composeOptions(methodRef: string, pending: PendingGrounding | undefined): GroundingOptions {
	return {
		methodRef,
		intent: pending?.intent ?? inferredIntent(methodRef),
		contract: { ref: `decl://${methodRef}` },
		...(pending?.params ? { params: pending.params } : {}),
		...(pending?.returns ? { output: { returns: { description: pending.returns } } } : {}),
	};
}

/** Compose options for a stage-3 bare-decorated method (granular or inferred). */
export function granularOptionsFor(
	methodRef: string,
	metadata: Record<PropertyKey, unknown> | undefined,
	methodName: string,
): GroundingOptions {
	const pending = (metadata?.[PENDING_GROUNDINGS] as PendingMap | undefined)?.get(methodName);
	return composeOptions(methodRef, pending);
}

/** Compose options for a legacy bare-decorated method. */
export function granularLegacyOptions(prototype: object, methodName: string): GroundingOptions {
	const owner = (prototype as { constructor?: { name?: string } }).constructor?.name;
	const methodRef = owner && owner !== "Object" ? `${owner}.${methodName}` : methodName;
	return composeOptions(methodRef, legacyPending.get(prototype)?.get(methodName));
}
