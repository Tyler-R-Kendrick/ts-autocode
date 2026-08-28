import { z } from "zod";

import type { PromotionDecision } from "./promotion.js";

// Before this module every failure was a bare Error, TypeError or SyntaxError
// carrying a good message and nothing else, so the only way to tell "not enough
// traces" from "no engine configured" from "gate rejected" was to match on
// message text -- which is exactly what the tests had to do.
//
// The message strings are preserved byte for byte, so existing catch blocks and
// substring assertions keep working; `code` and `instanceof` are added on top.

export type TsAutocodeErrorCode =
	| "engine_not_configured"
	| "executor_not_configured"
	| "applier_not_configured"
	| "promotion_rejected"
	| "insufficient_traces"
	| "training_incomplete"
	| "trace_not_found"
	| "candidate_syntax"
	| "engine_contract"
	| "engine_proposal"
	| "invalid_identity"
	| "invalid_settings"
	| "operation_interrupted"
	| "operation_timeout"
	| "loop_capability"
	| "missing_secret"
	| "source_discovery";

/** Present on every error this library throws, whatever its prototype chain. */
const brand: unique symbol = Symbol.for("ts-autocode.error") as never;

interface Branded {
	readonly [brand]: true;
	readonly code: TsAutocodeErrorCode;
}

function brandError(error: Error, code: TsAutocodeErrorCode): void {
	Object.defineProperty(error, brand, { value: true, enumerable: false });
	Object.defineProperty(error, "code", { value: code, enumerable: true, writable: false });
	Object.defineProperty(error, "name", { value: error.constructor.name, enumerable: false, writable: true });
}

/** Base class for every error this library throws.
 *
 * Some of these errors have always been `TypeError`s or `SyntaxError`s, and
 * consumers may catch them as such, so those subclasses keep those prototypes
 * rather than this one. `instanceof TsAutocodeError` still recognizes them:
 * membership is decided by a brand rather than by the prototype chain, so one
 * check covers the whole family without changing any error's existing type.
 * Subclasses are matched normally. */
export class TsAutocodeError extends Error {
	declare readonly code: TsAutocodeErrorCode;

	constructor(code: TsAutocodeErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		brandError(this, code);
	}

	static override [Symbol.hasInstance](value: unknown): boolean {
		// Subclasses keep ordinary prototype-chain semantics; only the base
		// generalizes to the brand.
		if (this !== TsAutocodeError) {
			return Function.prototype[Symbol.hasInstance].call(this, value);
		}
		return isTsAutocodeError(value);
	}
}

/** True for any error this library threw, including the ones that are also
 * `TypeError`s or `SyntaxError`s. Narrows to a `code` you can switch on. */
export function isTsAutocodeError(value: unknown): value is Error & Branded {
	return value instanceof Error && brand in value;
}

/** A `TypeError` that is also part of this library's error family. */
export class TsAutocodeTypeError extends TypeError {
	declare readonly code: TsAutocodeErrorCode;

	constructor(code: TsAutocodeErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		brandError(this, code);
	}
}

/** A `SyntaxError` that is also part of this library's error family. */
export class TsAutocodeSyntaxError extends SyntaxError {
	declare readonly code: TsAutocodeErrorCode;

	constructor(code: TsAutocodeErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		brandError(this, code);
	}
}

/** No `TrainingEngine` is available. The message names both the setting and the
 * import that supplies a default. */
export class EngineNotConfiguredError extends TsAutocodeError {
	constructor() {
		super("engine_not_configured", 'no training engine is configured; import "ts-autocode" for the Ax default or set TrainingSettings.engine');
	}
}

/** No `ImplementationExecutor` is available to run candidate bodies. */
export class ExecutorNotConfiguredError extends TsAutocodeError {
	constructor() {
		super("executor_not_configured", 'candidate execution requires an executor; import "ts-autocode" or set TrainingSettings.executor');
	}
}

/** No `PromotionApplier` is available to apply a gate-approved candidate. */
export class PromotionApplierNotConfiguredError extends TsAutocodeError {
	constructor() {
		super("applier_not_configured", 'activation requires a promotion applier; import "ts-autocode" for the default or set TrainingProviders.promote');
	}
}

/** Activation was attempted for a candidate the promotion gate did not pass.
 * Carries the decision, so the caller can report the failures without
 * re-running the gate. */
export class PromotionRejectedError extends TsAutocodeError {
	readonly candidateId: string;
	readonly decision: PromotionDecision | undefined;

	constructor(candidateId: string, decision?: PromotionDecision) {
		super("promotion_rejected", `candidate has not passed the promotion gate: ${candidateId}`);
		this.candidateId = candidateId;
		this.decision = decision;
	}

	/** Why the gate refused, when the decision is known. */
	get failures(): readonly string[] {
		return this.decision?.failures ?? [];
	}
}

/** Training from captured traffic needs more distinct successful traces than
 * the store holds. Carries both counts so a caller can report progress. */
export class InsufficientTracesError extends TsAutocodeError {
	readonly required: number;
	readonly found: number;

	constructor(required: number, found: number) {
		super(
			"insufficient_traces",
			`training from captured traffic requires ${required} distinct successful runtime trace${required === 1 ? "" : "s"}; found ${found}`,
		);
		this.required = required;
		this.found = found;
	}
}

/** A training run finished without a promotable candidate, or produced no
 * rounds at all. Carries the outcome rather than only naming it in prose. */
export class TrainingIncompleteError extends TsAutocodeError {
	readonly outcome: string;

	constructor(message: string, outcome: string) {
		super("training_incomplete", message);
		this.outcome = outcome;
	}

	static noPromotableCandidate(outcome: string): TrainingIncompleteError {
		return new TrainingIncompleteError(`background training did not produce a promotable candidate: ${outcome}`, outcome);
	}

	static noRounds(outcome: string): TrainingIncompleteError {
		return new TrainingIncompleteError(`training loop returned no rounds: ${outcome}`, outcome);
	}
}

/** A replayed evaluation asked for an input no captured trace supplies. */
export class TraceNotFoundError extends TsAutocodeError {
	readonly input: string;

	constructor(input: string) {
		super("trace_not_found", `live trace was not found for eval input: ${input}`);
		this.input = input;
	}
}

/** The engine returned something that is not valid TypeScript. Remains a
 * `SyntaxError`, which is what it was before. */
export class CandidateSyntaxError extends TsAutocodeSyntaxError {
	readonly trainableId: string;

	constructor(trainableId: string) {
		super("candidate_syntax", `engine returned invalid TypeScript for ${trainableId}`);
		this.trainableId = trainableId;
	}
}

/** The engine or its request violated the candidate contract: an empty
 * implementation, or records and evaluations bound to a different trainable. */
export class EngineContractError extends TsAutocodeError {
	constructor(message: string) {
		super("engine_contract", message);
	}
}

/** The engine could not produce a candidate. */
export class EngineProposalError extends TsAutocodeError {
	constructor(message: string) {
		super("engine_proposal", message);
	}
}

/** A required secret was not available from the secret provider or environment. */
export class MissingSecretError extends TsAutocodeError {
	readonly secret: string;

	constructor(secret: string, message: string) {
		super("missing_secret", message);
		this.secret = secret;
	}
}

/** The configured loop cannot honor a requested capability. Refusing beats
 * silently doing something else. */
export class LoopCapabilityError extends TsAutocodeError {
	constructor(message: string) {
		super("loop_capability", message);
	}
}

/** A trainable identity or id was not usable. Remains a `TypeError`. */
export class InvalidTrainableIdentityError extends TsAutocodeTypeError {
	constructor(message: string) {
		super("invalid_identity", message);
	}
}

/** Source discovery could not resolve a trainable or its TypeScript project. */
export class SourceDiscoveryError extends TsAutocodeError {
	constructor(message: string) {
		super("source_discovery", message);
	}
}

/** An operation was interrupted without a caller abort reason to surface. */
export class OperationInterruptedError extends TsAutocodeError {
	readonly operation: string;

	constructor(operation: string) {
		super("operation_interrupted", `${operation} was interrupted`);
		this.operation = operation;
	}
}

/** A setting failed validation. Wraps the underlying `ZodError` as `cause`
 * rather than letting it escape as a schema-library type. */
export class InvalidSettingsError extends TsAutocodeTypeError {
	constructor(message: string, options?: ErrorOptions) {
		super("invalid_settings", message, options);
	}
}

/** Parse with a Zod schema, surfacing failures as `InvalidSettingsError`
 * instead of leaking `ZodError` to consumers. The first issue's message is used
 * verbatim, so the schemas' hand-written messages still read as before. */
export function parseSetting<T>(schema: z.ZodType<T>, value: unknown): T {
	const result = schema.safeParse(value);
	if (result.success) return result.data;
	const issue = result.error.issues[0];
	throw new InvalidSettingsError(issue?.message ?? "invalid setting", { cause: result.error });
}
