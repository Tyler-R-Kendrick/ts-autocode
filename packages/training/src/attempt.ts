// Internal Effect-backed fallback helpers. Deliberately duplicated in each
// workspace package (harness, root) instead of adding a shared package for a
// handful of lines; keep the copies in sync.
import { Effect } from "effect";

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Runs `fn`, mapping a throw to `fallback(error)` — a sync error-to-value boundary. */
export function attempt<T>(fn: () => T, fallback: (error: unknown) => T): T {
	return Effect.runSync(Effect.try(fn).pipe(Effect.catchAll((error) => Effect.sync(() => fallback(error)))));
}

/** Async variant: resolves `fallback(error)` when `fn` throws or rejects. */
export function attemptAsync<T>(fn: () => Promise<T>, fallback: (error: unknown) => T): Promise<T> {
	return Effect.runPromise(
		Effect.tryPromise({ try: fn, catch: (error) => error }).pipe(
			Effect.catchAll((error) => Effect.sync(() => fallback(error))),
		),
	);
}
