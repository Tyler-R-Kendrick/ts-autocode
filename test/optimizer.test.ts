import { optimize as axOptimize, type AxProgrammable } from "@ax-llm/ax";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { findGeneratedRegion, optimizeRegions } from "../src/index.js";

vi.mock("@ax-llm/ax", () => ({ optimize: vi.fn() }));

const mockedOptimize = vi.mocked(axOptimize);
const source = `// autocode:generated-region begin region=one owner=ax
return "one";
// autocode:generated-region end region=one
// autocode:generated-region begin region=two owner=ax
return "two";
// autocode:generated-region end region=two
`;

type Input = { task: string };
type Output = { replacement: string };

function program(regionId: string): AxProgrammable<Input, Output> {
	return {
		applyOptimization: vi.fn(),
		forward: vi.fn(async () => ({ replacement: `return ${JSON.stringify(`${regionId}-optimized`)};` })),
	} as unknown as AxProgrammable<Input, Output>;
}

function axResult() {
	return {
		bestScore: 0.9,
		optimizedProgram: {
			optimizerType: "GEPA",
			converged: true,
			totalRounds: 2,
		},
	};
}

describe("optimizeRegions", () => {
	beforeEach(() => {
		mockedOptimize.mockReset();
	});

	it("uses Ax and trains independent regions concurrently", async () => {
		let active = 0;
		let maxActive = 0;
		mockedOptimize.mockImplementation(async () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 10));
			active -= 1;
			return axResult() as never;
		});
		const artifactRef = "src/generated.ts";
		const regions = ["one", "two"].map((id) => findGeneratedRegion(source, id, { artifactRef }));

		const candidate = await optimizeRegions<Input, Output, { task: string }>(
			{ artifacts: { [artifactRef]: source }, regions, data: { task: "improve routing" } },
			{
				studentAI: {} as never,
				program: ({ region }) => program(region.regionId),
				examples: () => [{ task: "example", expected: "optimized" }],
				metric: () => 1,
				input: ({ data }) => data,
				replacement: (output) => output.replacement,
			},
		);

		expect(mockedOptimize).toHaveBeenCalledTimes(2);
		expect(maxActive).toBe(2);
		expect(candidate.edits.map((edit) => edit.replacement)).toEqual([
			'return "one-optimized";',
			'return "two-optimized";',
		]);
		expect(candidate.optimization).toEqual([
			{ regionId: "one", bestScore: 0.9, optimizerType: "GEPA", converged: true, rounds: 2 },
			{ regionId: "two", bestScore: 0.9, optimizerType: "GEPA", converged: true, rounds: 2 },
		]);
	});

	it("honors the concurrency limit", async () => {
		let active = 0;
		let maxActive = 0;
		mockedOptimize.mockImplementation(async () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active -= 1;
			return axResult() as never;
		});
		const artifactRef = "src/generated.ts";
		const regions = ["one", "two"].map((id) => findGeneratedRegion(source, id, { artifactRef }));

		await optimizeRegions<Input, Output, null>(
			{ artifacts: { [artifactRef]: source }, regions, data: null },
			{
				studentAI: {} as never,
				program: ({ region }) => program(region.regionId),
				examples: () => [{ task: "example" }],
				metric: () => 1,
				input: () => ({ task: "optimize" }),
				replacement: (output) => output.replacement,
				concurrency: 1,
			},
		);

		expect(maxActive).toBe(1);
	});

	it("rejects duplicate region ids before starting Ax", async () => {
		const artifactRef = "src/generated.ts";
		const region = findGeneratedRegion(source, "one", { artifactRef });

		await expect(
			optimizeRegions<Input, Output, null>(
				{ artifacts: { [artifactRef]: source }, regions: [region, region], data: null },
				{
					studentAI: {} as never,
					program: () => program("one"),
					examples: () => [{ task: "example" }],
					metric: () => 1,
					input: () => ({ task: "optimize" }),
					replacement: (output) => output.replacement,
				},
			),
		).rejects.toThrow("region ids must be unique");
		expect(mockedOptimize).not.toHaveBeenCalled();
	});
});
