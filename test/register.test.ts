import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { installInstrumentation, instrumentKey, type Instrumentation } from "ts-autocode-rewrite";

import { augmentSource } from "../src/register/hook.js";

const registrySlot = Symbol.for(instrumentKey);
const globalSlots = globalThis as Record<symbol, unknown>;
const previousRegistry = globalSlots[registrySlot];

afterEach(() => {
	globalSlots[registrySlot] = previousRegistry;
});

const source = `export class Router {
  route(input) {
    "use training";
    return input;
  }
}
export function normalize(input) {
  "use training";
  return input;
}
export const callNormalize = (input) => normalize(input);
`;

async function importModule(text: string): Promise<Record<string, unknown>> {
	const directory = await mkdtemp(join(tmpdir(), "ts-autocode-register-"));
	const file = join(directory, "module.mjs");
	await writeFile(file, text, "utf8");
	return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
}

function recordingInstrumentation() {
	const methods: { owner: unknown; methodName: string; id: string }[] = [];
	const handlers: Instrumentation = {
		method: (owner, methodName, id) => {
			methods.push({ owner, methodName, id });
		},
		wrap: (fn, id) => ((...args) => `wrapped:${id}:${String((fn as (...next: never[]) => unknown)(...args))}`) as typeof fn,
	};
	return { handlers, methods };
}

describe("register source augmentation", () => {
	it("instruments directive-marked classes and functions when the module loads", async () => {
		const { handlers, methods } = recordingInstrumentation();
		installInstrumentation(handlers);

		const augmented = augmentSource(source, "/app/router.js");
		expect(augmented.startsWith(source)).toBe(true);

		const loaded = await importModule(augmented);
		expect(methods).toEqual([{ owner: loaded["Router"], methodName: "route", id: "Router.route" }]);
		const callNormalize = loaded["callNormalize"] as (input: string) => string;
		expect(callNormalize("x")).toBe("wrapped:normalize:x");
	});

	it("returns sources without trainables unchanged, including on parse-adjacent content", () => {
		expect(augmentSource("export const x = 1;\n", "/app/x.js")).toBe("export const x = 1;\n");
		const mention = "// mentions use training in a comment only\nexport const y = 2;\n";
		expect(augmentSource(mention, "/app/y.js")).toBe(mention);
	});

	it("loads cleanly even when the module defines clashing names or no runtime is installed", async () => {
		delete globalSlots[registrySlot];
		const clashing = `const __tsAutocodeInstrument = 1;\n${source}`;
		const loaded = await importModule(augmentSource(clashing, "/app/clash.js"));
		expect((loaded["callNormalize"] as (input: string) => string)("x")).toBe("x");
	});
});
