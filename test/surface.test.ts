import { describe, expect, it } from "vitest";

import * as root from "../src/index.js";
import * as rewrite from "ts-autocode-rewrite";
import * as training from "ts-autocode-training";


const valueNames = (module: object): readonly string[] =>
	Object.keys(module).filter((name) => name !== "default").sort();

describe("root export surface", () => {
	it.each([
		["ts-autocode-training", training],
		["ts-autocode-rewrite", rewrite],
	])("re-exports every runtime value from %s", (_name, module) => {
		const missing = valueNames(module).filter((name) => !(name in root));
		expect(missing).toEqual([]);
	});

	it("re-exports the same binding, not a copy", () => {
		expect(root.training).toBe(training.training);
		expect(root.sequentialLoop).toBe(training.sequentialLoop);
		expect(root.commitRewrite).toBe(rewrite.commitRewrite);
	});

	it("reaches the symbols the README documents by name", () => {
		for (const name of ["trainingRounds", "sequentialLoop", "defaultPromotionGates", "defaultOutputDir"]) {
			expect(root).toHaveProperty(name);
		}
	});
});
