import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTraining, defineTrainable, type BoundEvaluation } from "../src/index.js";
import { createAxEngine } from "../src/providers/ax.js";
import { discoverInSource } from "../src/source.js";

const mocks = vi.hoisted(() => ({
	ax: vi.fn(),
	optimize: vi.fn(),
	applyOptimization: vi.fn(),
	forward: vi.fn(),
}));

vi.mock("@ax-llm/ax", async (importOriginal) => ({
	...await importOriginal<typeof import("@ax-llm/ax")>(),
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
		mocks.optimize.mockImplementation(async (_program, examples, metric) => {
			expect(await metric({ prediction: { optimizedMethodImplementation: "return input.toUpperCase();" }, example: examples[0] }))
				.toBe(1);
			return {
				bestScore: 1,
				optimizedProgram: { optimizerType: "GEPA", converged: true, totalRounds: 2 },
			};
		});
	});

	it("derives the Ax program and executable metric from the method signature", async () => {
		const training = createTraining({ ax: { studentAI: {} as never } });
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

	it("keeps custom engines possible while making missing Ax configuration explicit", async () => {
		const engine = createAxEngine();
		await expect(engine.optimize(
			{ trainableId: token.id, objective: "improve", target, records: [], evaluations },
			{ variables: {} },
		)).rejects.toThrow("TrainingSettings.ax.studentAI");
	});
});
