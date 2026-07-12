import { Cause, Data, Duration, Effect, Exit, Option, Schedule } from "effect";

/** A per-attempt timeout imposed by a {@link ResiliencePolicy}. Retryable by
 * default, so a policy with both `timeoutMs` and `retry` re-attempts timed-out
 * operations. */
export class OperationTimeoutError extends Data.TaggedError("OperationTimeout")<{
	readonly operation: string;
	readonly timeoutMs: number;
}> {
	override get message(): string {
		return `${this.operation} timed out after ${this.timeoutMs}ms`;
	}
}

export interface RetryOptions {
	/** Total attempts including the first; 1 (the default) means no retries. */
	readonly attempts?: number;
	/** Base delay of the exponential backoff between attempts. */
	readonly delayMs?: number;
	/** Ceiling for the backoff delay. */
	readonly maxDelayMs?: number;
	/** Randomize each delay to avoid thundering herds; on by default. */
	readonly jitter?: boolean;
	/** Which failures are worth another attempt. Defaults to all of them;
	 * narrow this to skip deterministic failures like validation errors. */
	readonly retryable?: (error: unknown) => boolean;
}

/** Timeout and retry behavior for one named operation. An empty policy is the
 * identity: the operation runs exactly as it would without one. */
export interface ResiliencePolicy {
	/** Per-attempt time limit; expiry fails the attempt with {@link OperationTimeoutError}. */
	readonly timeoutMs?: number;
	readonly retry?: RetryOptions;
}

/** Named policies for the operations the training runtime performs, in the
 * style of a resilience-pipeline registry. Unnamed operations run bare. */
export interface ResilienceSettings {
	/** Candidate proposal — the engine/LLM call. */
	readonly propose?: ResiliencePolicy;
	/** Each candidate execution inside an evaluation run. Retries apply per
	 * eval case, which suits flaky sandboxes. */
	readonly evaluate?: ResiliencePolicy;
	/** Capture writes via `TrainingStore.append`. Retrying a store whose
	 * failures are ambiguous can append duplicates; keep retries off unless
	 * the store is idempotent or failures are known-clean. */
	readonly store?: ResiliencePolicy;
}

export const defaultRetry: Required<Omit<RetryOptions, "retryable">> = Object.freeze({
	attempts: 1,
	delayMs: 250,
	maxDelayMs: 10_000,
	jitter: true,
});

/** Runs `fn` under `policy`: per-attempt timeout, then jittered exponential
 * retry, composed with Effect and settled back into an ordinary promise.
 * Failures reject with the original error (or {@link OperationTimeoutError}),
 * never a wrapped one. Without a policy this is exactly `fn(signal)`. Each
 * attempt receives a signal that fires on the caller's `signal`, its own
 * timeout, or teardown; an aborted caller signal is never retried. */
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
		// Union takes the shorter interval, capping the exponential growth.
		Schedule.union(Schedule.spaced(Duration.millis(retry.maxDelayMs ?? defaultRetry.maxDelayMs))),
	);
	const backoff = (retry.jitter ?? defaultRetry.jitter) ? Schedule.jittered(capped) : capped;
	return backoff.pipe(
		Schedule.intersect(Schedule.recurs(attempts - 1)),
		Schedule.whileInput((error: unknown) => signal?.aborted !== true && retryable(error)),
	);
}

/** Settles an Effect exit into promise semantics: the typed failure or defect
 * rejects as itself, interruption surfaces the caller's abort reason. */
async function unwrapExit<T>(exit: Promise<Exit.Exit<T, unknown>>, operation: string, signal?: AbortSignal): Promise<T> {
	const settled = await exit;
	if (Exit.isSuccess(settled)) return settled.value;
	const failure = Cause.failureOption(settled.cause);
	if (Option.isSome(failure)) throw failure.value;
	const defect = Cause.dieOption(settled.cause);
	if (Option.isSome(defect)) throw defect.value;
	signal?.throwIfAborted();
	throw new Error(`${operation} was interrupted`);
}
