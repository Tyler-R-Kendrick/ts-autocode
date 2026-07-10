import type { EvalTestInput } from "@agentv/core";

import { configureTraining } from "../src/index.js";

const training = configureTraining();

class Router {
	route(input: string): string {
		"use training";
		return input.includes("invoice") ? "billing" : "fallback";
	}
}

const router = new Router();

const tests = [
	{ id: "billing", input: "Where is my invoice?", assert: [{ type: "equals", value: "billing" }] },
	{ id: "fallback", input: "Reset my password", assert: [{ type: "equals", value: "fallback" }] },
] satisfies EvalTestInput[];
const run = await training.train({
	trainable: "Router.route",
	objective: "Keep billing routing correct and preserve the fallback",
	evaluation: {
		tests,
		task: (input) => router.route(input),
		workers: 2,
		outputDir: "examples/output",
	},
});

console.log({ implementation: run.candidate.implementation, promote: run.decision.promote });
