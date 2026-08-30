// Granular grounding decorators: @intent / @returns on methods annotate an
// implementation one fact at a time — every decorator optional, every
// missing grounding inferred. A class-level finalizer (see component.ts)
// composes whatever was declared into GroundingOptions and registers each
// method with a host-provided registry.
//
// TC39 stage-3 decorators only. Stage-3 has no parameter decorators, so
// parameter metadata rides the options object as `params: { name:
// description("…") }` values.

/** A parameter or output annotation. */
export interface FieldDescription {
	readonly description: string;
	readonly example?: unknown;
}

/** A declared parameter or return shape, carried on the contract so a
 * registration grounds on the TypeScript signature even with no decorators. */
export interface ShapeDescriptor {
	readonly type: string;
	readonly optional?: boolean;
	readonly description?: string;
}

/** Provider-neutral composed grounding for one method. */
export interface GroundingOptions {
	readonly methodRef: string;
	readonly intent: string;
	readonly contract: {
		readonly ref: string;
		/** Declared parameter shapes, by parameter name. */
		readonly input?: Readonly<Record<string, ShapeDescriptor>>;
		readonly output?: ShapeDescriptor;
	};
	readonly params?: Record<string, FieldDescription>;
	readonly output?: { readonly returns: FieldDescription };
}

/** Validate and freeze one composed grounding. Generated registration source
 * calls this, so what codegen emits typechecks against a real API in the
 * package that owns the concept -- this package never imports a training
 * runtime, and a host registers the results against its own registry. */
export function defineGrounding(options: GroundingOptions): GroundingOptions {
	if (!options.methodRef?.trim()) {
		throw new TypeError("grounding methodRef must be a non-empty string");
	}
	if (!options.intent?.trim()) {
		throw new TypeError(`grounding intent must be a non-empty string for ${options.methodRef}`);
	}
	if (!options.contract?.ref?.trim()) {
		throw new TypeError(`grounding contract ref must be a non-empty string for ${options.methodRef}`);
	}
	return Object.freeze({ ...options, contract: Object.freeze({ ...options.contract }) });
}

export interface PendingGrounding {
	intent?: string;
	returns?: string;
	params?: Record<string, FieldDescription>;
}

export type PendingMap = Map<string, PendingGrounding>;

/** Pending groundings ride the class's `Symbol.metadata` record. */
export const PENDING_GROUNDINGS = Symbol.for("ts-autocode.grounding.pending");

interface MethodContext {
	readonly name: string | symbol;
	readonly metadata?: Record<PropertyKey, unknown>;
}

function pendingEntry(context: MethodContext): PendingGrounding | undefined {
	if (!context.metadata) return undefined;
	let map = context.metadata[PENDING_GROUNDINGS] as PendingMap | undefined;
	if (!map) {
		map = new Map();
		context.metadata[PENDING_GROUNDINGS] = map;
	}
	const method = String(context.name);
	const existing = map.get(method);
	if (existing) return existing;
	const created: PendingGrounding = {};
	map.set(method, created);
	return created;
}

/** `@intent("…")` — the method's generation intent. Optional; inferred when absent. */
export function intent(text: string) {
	return <Method>(method: Method, context: MethodContext): Method => {
		const entry = pendingEntry(context);
		if (entry) entry.intent = text;
		return method;
	};
}

/** `@returns("…")` — describes the output. Optional; lowers to output field metadata. */
export function returns(text: string) {
	return <Method>(method: Method, context: MethodContext): Method => {
		const entry = pendingEntry(context);
		if (entry) entry.returns = text;
		return method;
	};
}

/**
 * `description("…")` / `param("…")` — a `FieldDescription` value for the
 * `params:`/`output:` maps of grounding options; one expression per
 * parameter (stage-3 has no parameter decorators).
 */
export function description(text: string, example?: unknown): FieldDescription {
	return example === undefined ? Object.freeze({ description: text }) : Object.freeze({ description: text, example });
}

export { description as param };

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

/** Compose options for a bare-decorated method (granular or inferred). */
export function granularOptionsFor(
	methodRef: string,
	metadata: Record<PropertyKey, unknown> | undefined,
	methodName: string,
): GroundingOptions {
	const pending = (metadata?.[PENDING_GROUNDINGS] as PendingMap | undefined)?.get(methodName);
	return composeOptions(methodRef, pending);
}
