import { discoverInSource } from "ts-autocode-training";

export const instrumentKey = "ts-autocode.instrument";

/** Appends guarded instrumentation for every `"use training"` function so the
 * register runtime can capture calls without any consumer code. Pure: returns
 * the source unchanged when there is nothing to instrument or parsing fails. */
export function augmentSource(source: string, path: string): string {
	if (!source.includes("use training")) return source;
	let lines: string[];
	try {
		lines = discoverInSource(source, path).flatMap((target) => {
			if (target.className) {
				return `if (typeof ${target.className} === "function") __tsAutocodeInstrument.method(${target.className}, ${JSON.stringify(target.methodName)}, ${JSON.stringify(target.id)});`;
			}
			return `if (typeof ${target.methodName} === "function") ${target.methodName} = __tsAutocodeInstrument.wrap(${target.methodName}, ${JSON.stringify(target.id)});`;
		});
	} catch {
		return source;
	}
	if (lines.length === 0) return source;
	return `${source}
;const __tsAutocodeInstrument = globalThis[Symbol.for(${JSON.stringify(instrumentKey)})];
if (__tsAutocodeInstrument) {
${lines.join("\n")}
}
`;
}
