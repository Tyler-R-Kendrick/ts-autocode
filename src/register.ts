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

/** Environment switch for zero-config evolution; anything in `evolveOptOuts` disables it. */
export const evolveVariable = "TS_AUTOCODE_EVOLVE";
const evolveOptOuts = ["0", "false", "off"];

const evolveFlag = (process.env[evolveVariable] ?? "").trim().toLowerCase();
if (!evolveOptOuts.includes(evolveFlag)) {
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
