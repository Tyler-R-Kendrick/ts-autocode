import { describe, expect, it, vi } from "vitest";

import {
	configureTraining,
	defineTrainable,
	type ImplementationExecutor,
	type TrainingEngine,
} from "../src/index.js";
import { evaluateTrainable } from "../src/evaluation.js";

function pipelineTarget(input: string): string {
	"use training";
	return input;
}

const functionExecutor: ImplementationExecutor = async (target, implementation, args) =>
	new Function(...target.parameters.map((parameter) => parameter.name), implementation)(...args) as unknown;

describe("AgentV evaluation", () => {
	it("binds AgentV results to the trainable token", async () => {
		const token = defineTrainable("Router.route");
		const evaluated = await evaluateTrainable(token, {
			tests: [
				{ id: "upper", input: "hello", assert: [{ type: "equals", value: "HELLO" }] },
				{ id: "lower", input: "WORLD", assert: [{ type: "equals", value: "world" }] },
			],
			task: (input) => input === "hello" ? input.toUpperCase() : input.toLowerCase(),
			workers: 2,
			outputDir: "test/output/agentv-bindings",
		});

		expect(evaluated.run.summary).toMatchObject({ total: 2, passed: 2, failed: 0 });
		expect(evaluated.evaluations.every((evaluation) => evaluation.trainableId === token.id)).toBe(true);
	});

	it("feeds token-bound AgentV results into any configured engine", async () => {
		const engine: TrainingEngine = {
			id: "assert-evals",
			async optimize(request) {
				// The standalone evaluation and the training baseline are both remembered.
				expect(request.evaluations).toHaveLength(2);
				expect(request.evaluations.every((evaluation) => evaluation.trainableId === "pipelineTarget")).toBe(true);
				return { implementation: "return input;" };
			},
		};
		const route = defineTrainable("pipelineTarget");
		const training = configureTraining({ engine, executor: functionExecutor, source: { files: [import.meta.filename] } });
		const evaluation = {
			tests: [{ id: "identity", input: "hello", assert: [{ type: "equals" as const, value: "hello" }] }],
			task: (input: string) => input,
			outputDir: "test/output/agentv-training",
		};
		await training.evaluate(route.symbol, evaluation);

		const run = await training.train({ trainable: route.symbol, objective: "retain identity", evaluation });
		expect(run.outcome).toBe("ready");
	});

	it("feeds review failures back into the next optimization round", async () => {
		let round = 0;
		const signal = new AbortController().signal;
		const engine: TrainingEngine = {
			id: "student",
			async optimize(request) {
				round += 1;
				if (round === 2) {
					expect(request.constraints).toContain("Previous candidate rejection: mean AgentV score 0 is below 0.8");
					expect(request.evaluations).toHaveLength(2);
				}
				return { implementation: round === 1 ? "return input;" : "return input.toUpperCase();" };
			},
		};
		const executor = vi.fn(functionExecutor);
		const training = configureTraining({ engine, executor, source: { files: [import.meta.filename] } });
		const run = await training.train({
			trainable: defineTrainable("pipelineTarget").symbol,
			objective: "uppercase the result",
			signal,
			evaluation: {
				tests: [{ id: "uppercase", input: "hello", assert: [{ type: "equals", value: "HELLO" }] }],
				task: pipelineTarget,
				outputDir: "test/output/agentv-rounds",
			},
		});

		expect(run.outcome).toBe("ready");
		expect(run.baseline.run.summary.failed).toBe(1);
		expect(run.rounds).toHaveLength(2);
		// Candidate bodies run through the executor under the run's abort signal
		// (the loop derives its own signal from the caller's for cancellation).
		expect(executor.mock.calls[0]?.[3]?.signal).toBeInstanceOf(AbortSignal);
		expect(run.final.verification.run.summary.passed).toBe(1);
		expect(run.final.verification.evaluations[0]?.candidateId).toBe(run.final.candidate.id);
		expect(run.final.decision.promote).toBe(true);
	});

});
