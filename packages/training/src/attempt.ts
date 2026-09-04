// Internal fallback helpers. Deliberately duplicated in each workspace package
// (root src/, packages/training, packages/harness) instead of adding a shared
// package for a handful of lines; keep the copies identical.
//
// These are try/catch, and were written with Effect. That put a large runtime
// dependency in every consumer's tree to express two statements. Effect stays
// where it earns its place: packages/training/src/resilience.ts, whose
// timeout/retry/interruption composition is genuinely hard by hand.

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Runs `fn`, mapping a throw to `fallback(error)`, a sync error-to-value
 * boundary. The fallback receives the raw thrown value. */
export function attempt<T>(fn: () => T, fallback: (error: unknown) => T): T {
	try {
		return fn();
	} catch (error) {
		return fallback(error);
	}
}

/** Async variant: resolves `fallback(error)` when `fn` throws or rejects. */
export async function attemptAsync<T>(fn: () => Promise<T>, fallback: (error: unknown) => T): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		return fallback(error);
	}
}
