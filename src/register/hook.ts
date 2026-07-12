import { createRewriter } from "ts-autocode-rewrite";
import { discoverInSource, trainingMarker } from "ts-autocode-training";

export { instrumentKey } from "ts-autocode-rewrite";

/** Appends guarded instrumentation for every `"use training"` function so the
 * register runtime can capture calls without any consumer code. Pure: returns
 * the source unchanged when there is nothing to instrument or parsing fails. */
export const augmentSource = createRewriter(discoverInSource, trainingMarker);
