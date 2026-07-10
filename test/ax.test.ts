import { optimize as axOptimize, type AxProgrammable } from "@ax-llm/ax";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defineTrainable, findGeneratedRegion } from "../src/index.js";
import { createAxEngine } from "../src/providers/ax.js";
import { generatedRegionSource } from "./fixtures.js";

vi.mock("@ax-llm/ax", () => ({ optimize: vi.fn() }));

const mockedOptimize = vi.mocked(axOptimize);
const source = generatedRegionSource([
	{ id: "one", body: 'return "one";' },
	{ id: "two", body: 'return "two";' },
]);

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

describe("Ax engine adapter", () => {
	beforeEach(() => mockedOptimize.mockReset());

	it("uses the real Ax optimization boundary and parallelizes independent regions", async () => {
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
		const token = defineTrainable("router");
		const engine = createAxEngine<Input, Output>({
			studentAI: {} as never,
			program: ({ region }) => program(region.regionId),
			examples: ({ request }) => [{ task: request.objective }],
			metric: () => 1,
			input: ({ request }) => ({ task: request.objective }),
			replacement: (output) => output.replacement,
		});

		const candidate = await engine.optimize(
			{
				trainableId: token.id,
				objective: "improve routing",
				artifacts: { [artifactRef]: source },
				regions,
				records: [],
				evaluations: [],
			},
			{ variables: {} },
		);

		expect(mockedOptimize).toHaveBeenCalledTimes(2);
		expect(maxActive).toBe(2);
		expect(candidate.trainableId).toBe(token.id);
		expect(candidate.edits.map((edit) => edit.replacement)).toEqual([
			'return "one-optimized";',
			'return "two-optimized";',
		]);
	});

	it("honors the adapter concurrency setting", async () => {
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
		const token = defineTrainable("router");
		const engine = createAxEngine<Input, Output>({
			studentAI: {} as never,
			program: ({ region }) => program(region.regionId),
			examples: () => [{ task: "example" }],
			metric: () => 1,
			input: () => ({ task: "optimize" }),
			replacement: (output) => output.replacement,
			concurrency: 1,
		});
		await engine.optimize(
			{
				trainableId: token.id,
				objective: "improve",
				artifacts: { [artifactRef]: source },
				regions,
				records: [],
				evaluations: [],
			},
			{ variables: {} },
		);
		expect(maxActive).toBe(1);
	});
});
