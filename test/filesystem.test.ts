import { mkdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { configureTraining, discoverTrainables, type CandidatePatch } from "../src/index.js";

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
		const target = discoverTrainables({ files: [artifactRef] })[0]!;
		const candidate: CandidatePatch = {
			id: "filesystem-candidate",
			trainableId: target.id,
			engineId: "test",
			target,
			implementation: "return input.toUpperCase();",
		};
		const training = configureTraining({});
		const promoted = await training.promote(candidate, {
			candidateId: candidate.id,
			promote: true,
			failures: [],
			meanScore: 1,
			passRate: 1,
		});

		expect(await readFile(artifactRef, "utf8")).toContain("return input.toUpperCase();");
		await training.revert(promoted.snapshot);
		expect(await readFile(artifactRef, "utf8")).toBe(source);
	});
});
