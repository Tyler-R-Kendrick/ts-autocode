import type { EvalTestInput } from "@agentv/core";

import { configureTraining, defineTrainable } from "../src/index.js";

class Router {
	route(input: string): string {
		"use training";
		return input.includes("invoice") ? "billing" : "fallback";
	}
}

const tests = [
	{ id: "billing", input: "Where is my invoice?", assert: [{ type: "equals", value: "billing" }] },
	{ id: "fallback", input: "Reset my password", assert: [{ type: "equals", value: "fallback" }] },
] satisfies EvalTestInput[];

// The token's symbol binds these evals to the directive-marked method above.
const route = defineTrainable("Router.route");

export async function optimizeRouter() {
	const training = configureTraining({ source: { files: [import.meta.filename] } });
	const router = new Router();
	return training.train({
		trainable: route.symbol,
		objective: "Keep billing routing correct and preserve the fallback",
		evaluation: {
			tests,
			task: (input) => router.route(input),
			workers: 2,
			outputDir: "examples/output",
		},
	});
}
