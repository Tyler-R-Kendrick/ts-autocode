import { describe, expect, it } from "vitest";

import {
	defineTrainable,
	evaluateTrainable,
	findGeneratedRegion,
	useTraining,
	type TrainingEngine,
} from "../src/index.js";

describe("AgentV evaluation", () => {
	it("binds AgentV results to the trainable token", async () => {
		const token = defineTrainable("router.route");
		const evaluated = await evaluateTrainable(token, {
			tests: [
				{ id: "upper", input: "hello", assert: [{ type: "equals", value: "HELLO" }] },
				{ id: "lower", input: "WORLD", assert: [{ type: "equals", value: "world" }] },
			],
			task: (input) => (input === "hello" ? input.toUpperCase() : input.toLowerCase()),
			workers: 2,
			outputDir: "test/output/agentv-bindings",
		});

		expect(evaluated.run.summary).toMatchObject({ total: 2, passed: 2, failed: 0 });
		expect(evaluated.evaluations.every((evaluation) => evaluation.trainableId === token.id)).toBe(true);
		expect(evaluated.evaluations.map((evaluation) => evaluation.result.testId).sort()).toEqual([
			"lower",
			"upper",
		]);
	});

	it("feeds bound AgentV results into the configured engine", async () => {
		const token = defineTrainable("router.route");
		const source = `// autocode:generated-region begin region=route owner=training\nreturn input;\n// autocode:generated-region end region=route\n`;
		const region = findGeneratedRegion(source, "route", { artifactRef: "src/router.ts" });
		const engine: TrainingEngine = {
			id: "assert-evals",
			async optimize(request) {
				expect(request.evaluations).toHaveLength(1);
				expect(request.evaluations[0]?.trainableId).toBe(token.id);
				return {
					id: "candidate",
					trainableId: token.id,
					engineId: "assert-evals",
					edits: [{
						artifactRef: region.artifactRef,
						regionId: region.regionId,
						startOffset: region.startOffset,
						endOffset: region.endOffset,
						replacement: "return input;",
					}],
				};
			},
		};
		const training = useTraining({ engine });
		await training.evaluate(token, {
			tests: [{ id: "identity", input: "hello", assert: [{ type: "equals", value: "hello" }] }],
			task: (input) => input,
			outputDir: "test/output/agentv-training",
		});

		await training.optimize({
			token,
			objective: "retain identity",
			artifacts: { [region.artifactRef]: source },
			regions: [region],
		});
	});
});
