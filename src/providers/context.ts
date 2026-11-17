import type { ContextProvider } from "ts-autocode-harness";
import { z } from "zod";

export const defaultContextWindow = 100;

const contextWindow = z.number().int().min(0, "context window must be a non-negative integer");

export function windowedContext(limit = defaultContextWindow): ContextProvider {
	const window = contextWindow.parse(limit);
	return (entries) => entries.slice(Math.max(entries.length - window, 0));
}
