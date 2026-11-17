import { describe, it } from "vitest";

import * as root from "../src/index.js";
import * as internal from "../src/internal.js";
import * as ax from "../src/providers/ax.js";
import * as grounding from "../src/grounding.js";
import * as harness from "ts-autocode-harness";
import * as rewrite from "ts-autocode-rewrite";
import * as training from "ts-autocode-training";
import { verify, verifyJson } from "./support/verify.js";


const entries: ReadonlyArray<readonly [string, object]> = [
	["ts-autocode", root],
	["ts-autocode-internal", internal],
	["ts-autocode-ax", ax],
	["ts-autocode-grounding", grounding],
	["ts-autocode-harness", harness],
	["ts-autocode-rewrite", rewrite],
	["ts-autocode-training", training],
];

describe("public export surface", () => {
	it.each(entries)("%s exports", async (name, module) => {
		await verify(`surface/${name}.txt`,
			`${Object.keys(module).filter((key) => key !== "default").sort().join("\n")}\n`);
	});

	it("records what each export is, so a value silently becoming a type is visible", async () => {
		await verifyJson("surface/root-export-kinds", Object.fromEntries(
			Object.keys(root).filter((key) => key !== "default").sort()
				.map((key) => [key, kindOf((root as Record<string, unknown>)[key])]),
		));
	});
});

function kindOf(value: unknown): string {
	if (typeof value === "function") {
		return /^class\s/.test(Function.prototype.toString.call(value)) ? "class" : "function";
	}
	if (Array.isArray(value)) return "array";
	if (value === null) return "null";
	return typeof value;
}
