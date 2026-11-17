import { z } from "zod";

import type { PromotionDecision } from "./promotion.js";


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

export class TsAutocodeError extends Error {
	declare readonly code: TsAutocodeErrorCode;

	constructor(code: TsAutocodeErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		brandError(this, code);
	}

	static override [Symbol.hasInstance](value: unknown): boolean {
		if (this !== TsAutocodeError) {
			return Function.prototype[Symbol.hasInstance].call(this, value);
		}
		return isTsAutocodeError(value);
	}
}

export function isTsAutocodeError(value: unknown): value is Error & Branded {
	return value instanceof Error && brand in value;
}

export class TsAutocodeTypeError extends TypeError {
	declare readonly code: TsAutocodeErrorCode;

	constructor(code: TsAutocodeErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		brandError(this, code);
	}
}

export class TsAutocodeSyntaxError extends SyntaxError {
	declare readonly code: TsAutocodeErrorCode;

	constructor(code: TsAutocodeErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		brandError(this, code);
	}
}

export class EngineNotConfiguredError extends TsAutocodeError {
	constructor() {
		super("engine_not_configured", 'no training engine is configured; import "ts-autocode" for the Ax default or set TrainingSettings.engine');
	}
}

export class ExecutorNotConfiguredError extends TsAutocodeError {
	constructor() {
		super("executor_not_configured", 'candidate execution requires an executor; import "ts-autocode" or set TrainingSettings.executor');
	}
}

export class PromotionApplierNotConfiguredError extends TsAutocodeError {
	constructor() {
		super("applier_not_configured", 'activation requires a promotion applier; import "ts-autocode" for the default or set TrainingProviders.promote');
	}
}

export class PromotionRejectedError extends TsAutocodeError {
	readonly candidateId: string;
	readonly decision: PromotionDecision | undefined;

	constructor(candidateId: string, decision?: PromotionDecision) {
		super("promotion_rejected", `candidate has not passed the promotion gate: ${candidateId}`);
		this.candidateId = candidateId;
		this.decision = decision;
	}

	get failures(): readonly string[] {
		return this.decision?.failures ?? [];
	}
}

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

export class TraceNotFoundError extends TsAutocodeError {
	readonly input: string;

	constructor(input: string) {
		super("trace_not_found", `live trace was not found for eval input: ${input}`);
		this.input = input;
	}
}

export class CandidateSyntaxError extends TsAutocodeSyntaxError {
	readonly trainableId: string;

	constructor(trainableId: string) {
		super("candidate_syntax", `engine returned invalid TypeScript for ${trainableId}`);
		this.trainableId = trainableId;
	}
}

export class EngineContractError extends TsAutocodeError {
	constructor(message: string) {
		super("engine_contract", message);
	}
}

export class EngineProposalError extends TsAutocodeError {
	constructor(message: string) {
		super("engine_proposal", message);
	}
}

export class MissingSecretError extends TsAutocodeError {
	readonly secret: string;

	constructor(secret: string, message: string) {
		super("missing_secret", message);
		this.secret = secret;
	}
}

export class LoopCapabilityError extends TsAutocodeError {
	constructor(message: string) {
		super("loop_capability", message);
	}
}

export class InvalidTrainableIdentityError extends TsAutocodeTypeError {
	constructor(message: string) {
		super("invalid_identity", message);
	}
}

export class SourceDiscoveryError extends TsAutocodeError {
	constructor(message: string) {
		super("source_discovery", message);
	}
}

export class OperationInterruptedError extends TsAutocodeError {
	readonly operation: string;

	constructor(operation: string) {
		super("operation_interrupted", `${operation} was interrupted`);
		this.operation = operation;
	}
}

export class InvalidSettingsError extends TsAutocodeTypeError {
	constructor(message: string, options?: ErrorOptions) {
		super("invalid_settings", message, options);
	}
}

export function positiveIntegerSetting(message: string) {
	return z.number({ error: message }).int(message).positive(message);
}

export function parseSetting<T>(schema: z.ZodType<T>, value: unknown): T {
	const result = schema.safeParse(value);
	if (result.success) return result.data;
	const issue = result.error.issues[0];
	throw new InvalidSettingsError(issue?.message ?? "invalid setting", { cause: result.error });
}
