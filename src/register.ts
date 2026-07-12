import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

import { installInstrumentation } from "ts-autocode-rewrite";
import { instrumentTrainable, provideTrainingDefaults, wrapTrainable } from "ts-autocode-training";

import { augmentSource } from "./register/hook.js";
// Importing the package entry wires the Ax engine and executor defaults.
import "./index.js";

installInstrumentation({ method: instrumentTrainable, wrap: wrapTrainable });

const evolveFlag = (process.env["TS_AUTOCODE_EVOLVE"] ?? "").trim().toLowerCase();
if (!["0", "false", "off"].includes(evolveFlag)) {
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
