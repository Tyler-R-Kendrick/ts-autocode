import { describe, expect, it } from "vitest";

import {
	configureTraining,
	defineTrainable,
	type CandidatePatch,
	type TrainingEngine,
} from "../src/index.js";
import { evaluateTrainable } from "../src/evaluation.js";
import { discoverInSource } from "../src/source.js";

function pipelineTarget(input: string): string {
	"use training";
	return input;
}

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
		const source = `class Router {
  route(input: string): string {
    "use training";
    return input;
  }
}`;
		const target = discoverInSource(source, "src/router.ts")[0]!;
		const engine: TrainingEngine = {
			id: "assert-evals",
			async optimize(request) {
				expect(request.evaluations).toHaveLength(1);
				expect(request.evaluations[0]?.trainableId).toBe("Router.route");
				return { implementation: "return input;" };
			},
		};
		const training = configureTraining({ engine });
		await training.evaluate("Router.route", {
			tests: [{ id: "identity", input: "hello", assert: [{ type: "equals", value: "hello" }] }],
			task: (input) => input,
			outputDir: "test/output/agentv-training",
		});

		await training.optimize({ trainable: "Router.route", objective: "retain identity", target });
	});

	it("runs AgentV against the candidate body before promotion", async () => {
		const source = `function normalize(input: string): string {
  "use training";
  return input;
}`;
		const target = discoverInSource(source, "src/normalize.ts")[0]!;
		const candidate: CandidatePatch = {
			id: "candidate",
			trainableId: target.id,
			engineId: "test",
			target,
			implementation: "return input.toUpperCase();",
		};
		const evaluated = await configureTraining({}).evaluateCandidate(candidate, {
			tests: [{ id: "uppercase", input: "hello", assert: [{ type: "equals", value: "HELLO" }] }],
			outputDir: "test/output/agentv-candidate",
		});

		expect(evaluated.run.summary).toMatchObject({ total: 1, passed: 1, failed: 0 });
	});

	it("uses the harness for student optimization and teacher feedback", async () => {
		let round = 0;
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
		const training = configureTraining({ engine, source: { files: [import.meta.filename] } });
		const run = await training.train({
			trainable: "pipelineTarget",
			objective: "uppercase the result",
			evaluation: {
				tests: [{ id: "uppercase", input: "hello", assert: [{ type: "equals", value: "HELLO" }] }],
				task: pipelineTarget,
				outputDir: "test/output/agentv-harness",
			},
		});

		expect(run.outcome).toBe("ready");
		expect(run.baseline.run.summary.failed).toBe(1);
		expect(run.rounds).toHaveLength(2);
		expect(run.final.verification.run.summary.passed).toBe(1);
		expect(run.final.decision.promote).toBe(true);
	});

});
