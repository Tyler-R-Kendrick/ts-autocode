
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function attempt<T>(fn: () => T, fallback: (error: unknown) => T): T {
	try {
		return fn();
	} catch (error) {
		return fallback(error);
	}
}

export async function attemptAsync<T>(fn: () => Promise<T>, fallback: (error: unknown) => T): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		return fallback(error);
	}
}
