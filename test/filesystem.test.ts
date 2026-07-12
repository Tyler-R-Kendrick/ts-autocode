import { mkdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { configureTraining, defineTrainable, type ImplementationExecutor } from "../src/index.js";

const functionExecutor: ImplementationExecutor = async (target, implementation, args) =>
	new Function(...target.parameters.map((parameter) => parameter.name), implementation)(...args) as unknown;

describe("filesystem isolation", () => {
	it("rewrites only the discovered method in ignored test output", async () => {
		const outputDir = "test/output/rewrite";
		const artifactRef = `${outputDir}/generated.ts`;
		const source = `class Fixture {
  route(input: string): string {
    "use training";
    return input;
  }
}`;
		await mkdir(outputDir, { recursive: true });
		await writeFile(artifactRef, source, "utf8");
		const training = configureTraining({
			engine: { id: "filesystem-test", optimize: async () => ({ implementation: "return input.toUpperCase();" }) },
			executor: functionExecutor,
			source: { files: [artifactRef] },
			tracing: { enabled: false },
		});
		const run = await training.train({
			trainable: defineTrainable("Fixture.route").symbol,
			objective: "Uppercase the routed input",
			evaluation: {
				tests: [{ id: "uppercase", input: "abc", assert: [{ type: "equals", value: "ABC" }] }],
				task: (input) => input,
				outputDir: `${outputDir}/agentv`,
			},
		});

		expect(run.outcome).toBe("ready");
		const activation = await run.activate();
		expect(await readFile(artifactRef, "utf8")).toContain("return input.toUpperCase();");
		await activation.rollback();
		expect(await readFile(artifactRef, "utf8")).toBe(source);
	});
});
