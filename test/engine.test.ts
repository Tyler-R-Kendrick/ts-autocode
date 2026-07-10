import { describe, expect, it } from "vitest";

import {
	applyCandidate,
	defineTrainable,
	findGeneratedRegion,
	optimizeCandidate,
	type CandidatePatch,
	type TrainingEngine,
} from "../src/index.js";
import { generatedRegionSource } from "./fixtures.js";

const source = `const before = true;\n${generatedRegionSource([
	{ id: "first", body: 'return "first";' },
	{ id: "second", body: 'return "second";' },
])}`;
const token = defineTrainable("router.classify");

function fixture() {
	const artifactRef = "src/generated.ts";
	const regions = ["first", "second"].map((id) => findGeneratedRegion(source, id, { artifactRef }));
	const candidate: CandidatePatch = {
		id: "candidate",
		trainableId: token.id,
		engineId: "test-engine",
		edits: regions.map((region) => ({
			artifactRef,
			regionId: region.regionId,
			startOffset: region.startOffset,
			endOffset: region.endOffset,
			replacement: `return ${JSON.stringify(`${region.regionId}-optimized`)};`,
		})),
	};
	return { artifactRef, regions, candidate };
}

describe("provider-neutral engine", () => {
	it("passes settings-backed variables and secrets to any engine", async () => {
		const { artifactRef, regions, candidate } = fixture();
		const engine: TrainingEngine = {
			id: "test-engine",
			async optimize(request, context) {
				expect(request.trainableId).toBe(token.id);
				expect(context.variables["MODEL"]).toBe("test-model");
				expect(await context.secrets?.get("API_KEY")).toBe("secret");
				return candidate;
			},
		};

		await expect(
			optimizeCandidate(
				engine,
				{
					trainableId: token.id,
					objective: "improve routing",
					artifacts: { [artifactRef]: source },
					regions,
					records: [],
					evaluations: [],
				},
				{
					variables: { MODEL: "test-model" },
					secrets: { async get() { return "secret"; } },
				},
			),
		).resolves.toEqual(candidate);
	});
});

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
