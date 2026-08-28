import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

import { installInstrumentation } from "ts-autocode-rewrite";
import { provideTrainingDefaults } from "ts-autocode-training";

import { instrumentTrainable, wrapTrainable } from "./instrumentation.js";
import { augmentSource } from "./register/hook.js";
// Importing the package entry wires the Ax engine and executor defaults, the
// harness loop, the promotion applier, and rewrite capture interception.
import "./index.js";

installInstrumentation({ method: instrumentTrainable, wrap: wrapTrainable });

/** Environment switch for zero-config evolution. Loading this module is itself
 * the opt-in, so an unset variable leaves evolution on; the variable exists to
 * turn it back off without changing the command line. */
export const evolveVariable = "TS_AUTOCODE_EVOLVE";
const evolveOff = ["0", "false", "off", "no", "disabled"];
const evolveOn = ["1", "true", "on", "yes", "enabled"];

/** Reads the kill switch, failing closed: an unrecognized value throws rather
 * than being guessed at. Evolution rewrites the user's source files, so a
 * misspelled `TS_AUTOCODE_EVOLVE=nope` must never be read as consent. */
export function evolutionEnabled(value: string | undefined): boolean {
	const flag = (value ?? "").trim().toLowerCase();
	if (flag === "") return true;
	if (evolveOff.includes(flag)) return false;
	if (evolveOn.includes(flag)) return true;
	throw new Error(
		`${evolveVariable} must be one of ${[...evolveOn, ...evolveOff].join(", ")}; received ${JSON.stringify(value)}`,
	);
}

if (evolutionEnabled(process.env[evolveVariable])) {
	provideTrainingDefaults({ evolution: { enabled: true } });
}

registerHooks({
	load(url, context, nextLoad) {
		const result = nextLoad(url, context);
		if (!url.startsWith("file:") || url.includes("/node_modules/")) return result;
		const source = result.source;
		if (typeof source !== "string" && !(source instanceof Uint8Array)) return result;
		const text = typeof source === "string" ? source : Buffer.from(source).toString("utf8");
		const augmented = augmentSource(text, fileURLToPath(url));
		return augmented === text ? result : { ...result, source: augmented };
	},
});
