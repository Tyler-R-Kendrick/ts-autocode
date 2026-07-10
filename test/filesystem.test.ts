import { mkdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { applyCandidate, defineTrainable, findGeneratedRegion } from "../src/index.js";
import { generatedRegionSource } from "./fixtures.js";

describe("filesystem isolation", () => {
	it("writes rewritten artifacts only to ignored test output", async () => {
		const outputDir = "test/output/rewrite";
		const artifactRef = `${outputDir}/generated.ts`;
		const source = generatedRegionSource([{ id: "route", body: 'export const route = "before";' }]);
		const region = findGeneratedRegion(source, "route", { artifactRef });
		const token = defineTrainable("fixture.route");

		await mkdir(outputDir, { recursive: true });
		await writeFile(artifactRef, source, "utf8");
		const artifacts = applyCandidate(
			{ [artifactRef]: await readFile(artifactRef, "utf8") },
			{
				id: "filesystem-candidate",
				trainableId: token.id,
				engineId: "test",
				edits: [{
					artifactRef,
					regionId: region.regionId,
					startOffset: region.startOffset,
					endOffset: region.endOffset,
					replacement: 'export const route = "after";',
				}],
			},
			[region],
		);
		await writeFile(artifactRef, artifacts[artifactRef] as string, "utf8");

		expect(await readFile(artifactRef, "utf8")).toContain('export const route = "after";');
	});
});
