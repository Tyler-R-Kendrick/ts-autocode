import { Cause, Data, Duration, Effect, Exit, Option, Schedule } from "effect";

import { OperationInterruptedError } from "./errors.js";

export class OperationTimeoutError extends Data.TaggedError("OperationTimeout")<{
	readonly operation: string;
	readonly timeoutMs: number;
}> {
	override get message(): string {
		return `${this.operation} timed out after ${this.timeoutMs}ms`;
	}
}

export interface RetryOptions {
	readonly attempts?: number;
	readonly delayMs?: number;
	readonly maxDelayMs?: number;
	readonly jitter?: boolean;
	readonly retryable?: (error: unknown) => boolean;
}

export interface ResiliencePolicy {
	readonly timeoutMs?: number;
	readonly retry?: RetryOptions;
}

export interface ResilienceSettings {
	readonly propose?: ResiliencePolicy;
	readonly evaluate?: ResiliencePolicy;
	readonly store?: ResiliencePolicy;
}

export const defaultRetry: Required<Omit<RetryOptions, "retryable">> = Object.freeze({
	attempts: 1,
	delayMs: 250,
	maxDelayMs: 10_000,
	jitter: true,
});

export function withPolicy<T>(
	policy: ResiliencePolicy | undefined,
	operation: string,
	fn: (signal?: AbortSignal) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (policy?.timeoutMs === undefined && policy?.retry === undefined) return fn(signal);
	const { timeoutMs, retry } = policy;
	const bare: Effect.Effect<T, unknown> = Effect.tryPromise({
		try: (attemptSignal) => fn(signal === undefined ? attemptSignal : AbortSignal.any([signal, attemptSignal])),
		catch: (error) => error,
	});
	const attempt = timeoutMs === undefined ? bare : bare.pipe(Effect.timeoutFail({
		duration: Duration.millis(timeoutMs),
		onTimeout: () => new OperationTimeoutError({ operation, timeoutMs }),
	}));
	return unwrapExit(
		Effect.runPromiseExit(
			Effect.retry(attempt, retrySchedule(retry ?? {}, signal)),
			signal === undefined ? undefined : { signal },
		),
		operation,
		signal,
	);
}

function retrySchedule(retry: RetryOptions, signal: AbortSignal | undefined): Schedule.Schedule<unknown, unknown> {
	const attempts = Math.max(1, Math.floor(retry.attempts ?? defaultRetry.attempts));
	const retryable = retry.retryable ?? (() => true);
	const capped = Schedule.exponential(Duration.millis(retry.delayMs ?? defaultRetry.delayMs)).pipe(
		Schedule.union(Schedule.spaced(Duration.millis(retry.maxDelayMs ?? defaultRetry.maxDelayMs))),
	);
	const backoff = (retry.jitter ?? defaultRetry.jitter) ? Schedule.jittered(capped) : capped;
	return backoff.pipe(
		Schedule.intersect(Schedule.recurs(attempts - 1)),
		Schedule.whileInput((error: unknown) => signal?.aborted !== true && retryable(error)),
	);
}

async function unwrapExit<T>(exit: Promise<Exit.Exit<T, unknown>>, operation: string, signal?: AbortSignal): Promise<T> {
	const settled = await exit;
	if (Exit.isSuccess(settled)) return settled.value;
	const failure = Cause.failureOption(settled.cause);
	if (Option.isSome(failure)) throw failure.value;
	const defect = Cause.dieOption(settled.cause);
	if (Option.isSome(defect)) throw defect.value;
	signal?.throwIfAborted();
	throw new OperationInterruptedError(operation);
}
