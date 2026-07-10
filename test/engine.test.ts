import { describe, expect, it } from "vitest";

import { applyCandidate, findGeneratedRegion, type CandidatePatch } from "../src/index.js";

const source = `const before = true;
// autocode:generated-region begin region=first owner=ax
return "first";
// autocode:generated-region end region=first
// autocode:generated-region begin region=second owner=ax
return "second";
// autocode:generated-region end region=second
`;

function fixture() {
	const artifactRef = "src/generated.ts";
	const regions = ["first", "second"].map((id) => findGeneratedRegion(source, id, { artifactRef }));
	const candidate: CandidatePatch = {
		id: "candidate",
		edits: regions.map((region) => ({
			artifactRef,
			regionId: region.regionId,
			startOffset: region.startOffset,
			endOffset: region.endOffset,
			replacement: `return ${JSON.stringify(`${region.regionId}-optimized`)};`,
		})),
		optimization: [],
	};
	return { artifactRef, regions, candidate };
}

describe("applyCandidate", () => {
	it("applies multiple edits without offset drift", () => {
		const { artifactRef, regions, candidate } = fixture();
		const result = applyCandidate({ [artifactRef]: source }, candidate, regions);

		expect(result[artifactRef]).toContain('return "first-optimized";');
		expect(result[artifactRef]).toContain('return "second-optimized";');
		expect(source).toContain('return "first";');
	});

	it("refuses a stale region", () => {
		const { artifactRef, regions, candidate } = fixture();
		const changed = source.replace('return "first";', 'return "changed";');

		expect(() => applyCandidate({ [artifactRef]: changed }, candidate, regions)).toThrow(
			"changed after optimization started",
		);
	});

	it("requires one complete edit per region", () => {
		const { artifactRef, regions, candidate } = fixture();
		const incomplete = { ...candidate, edits: candidate.edits.slice(0, 1) };

		expect(() => applyCandidate({ [artifactRef]: source }, incomplete, regions)).toThrow(
			"replace every requested region exactly once",
		);
	});
});
