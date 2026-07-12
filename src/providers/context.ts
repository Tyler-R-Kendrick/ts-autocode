import type { ContextProvider } from "ts-autocode-harness";
import { z } from "zod";

/** How many trailing bus entries the default context provider keeps. */
export const defaultContextWindow = 100;

const contextWindow = z.number().int().min(0, "context window must be a non-negative integer");

/** Rolling-window context: actors see the trailing `limit` bus entries (zero
 * means none). The bus does no context management, so optimization lives here
 * — a consumer needing more than a window (rolling summaries in the style of
 * Semantic Kernel's chat-history reduction, relevance filtering, ...)
 * substitutes its own ContextProvider. */
export function windowedContext(limit = defaultContextWindow): ContextProvider {
	const window = contextWindow.parse(limit);
	return (entries) => entries.slice(Math.max(entries.length - window, 0));
}
