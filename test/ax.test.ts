import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureTraining, defineTrainable, type BoundEvaluation } from "../src/index.js";
import { createAxEngine } from "../src/providers/ax.js";
import { discoverInSource } from "../src/source.js";

const mocks = vi.hoisted(() => ({
	ax: vi.fn(),
	optimize: vi.fn(),
	applyOptimization: vi.fn(),
	forward: vi.fn(),
	ai: vi.fn(),
}));

vi.mock("@ax-llm/ax", async (importOriginal) => ({
	...await importOriginal<typeof import("@ax-llm/ax")>(),
	ai: mocks.ai,
	ax: mocks.ax,
	optimize: mocks.optimize,
}));

const source = `class Router {
  route(input: string): string {
    "use training";
    return input;
  }
}`;
const target = discoverInSource(source, "src/router.ts")[0]!;
const token = defineTrainable("Router.route");
const evaluations: BoundEvaluation[] = [{
	trainableId: token.id,
	test: { id: "uppercase", input: "hello", assert: [{ type: "equals", value: "HELLO" }] },
	result: {
		input: [{ role: "user", content: '["hello"]' }],
		output: "hello",
		executionStatus: "quality_failure",
	} as never,
}];

describe("default Ax engine", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.ax.mockReturnValue({ applyOptimization: mocks.applyOptimization, forward: mocks.forward });
		mocks.forward.mockResolvedValue({ optimizedMethodImplementation: "return input.toUpperCase();" });
		mocks.ai.mockReturnValue({});
		mocks.optimize.mockImplementation(async (_program, examples, metric) => {
			expect(await metric({ prediction: { optimizedMethodImplementation: "return input.toUpperCase();" }, example: examples[0] }))
				.toBe(1);
			return {
				bestScore: 1,
				optimizedProgram: { optimizerType: "GEPA", converged: true, totalRounds: 2 },
			};
		});
	});
	afterEach(() => vi.unstubAllEnvs());

	it("derives the Ax program and executable metric from the method signature", async () => {
		const training = configureTraining({ engine: createAxEngine({ studentAI: {} as never }) });
		const candidate = await training.optimize({
			trainable: token,
			objective: "uppercase the result",
			target,
			evaluations,
		});

		const signature = mocks.ax.mock.calls[0]?.[0] as {
			description: string;
			inputs: Array<{ name: string; description?: string }>;
		};
		expect(signature.description).toContain("route(input: string): string");
		expect(signature.inputs.map(({ name }) => name)).toEqual([
			"methodArgumentInput",
			"trainingObjective",
			"currentMethodImplementation",
		]);
		expect(signature.inputs[0]?.description).toBe("input: string");
		expect(mocks.optimize).toHaveBeenCalledOnce();
		expect(candidate).toMatchObject({ engineId: "@ax-llm/ax", implementation: "return input.toUpperCase();" });
	});

	it("uses standard environment credentials without provider-specific root settings", async () => {
		vi.stubEnv("OPENAI_API_KEY", "test-key");
		const engine = createAxEngine();
		await engine.optimize(
			{ trainableId: token.id, objective: "improve", target, records: [], evaluations },
			{ variables: {} },
		);
		expect(mocks.ai).toHaveBeenCalledWith({ name: "openai", apiKey: "test-key" });
	});
});
