import { mkdir, writeFile } from "node:fs/promises";

import { ai, ax } from "@ax-llm/ax";

import {
	defineTrainable,
	evaluatePromotionGate,
	findGeneratedRegion,
	promoteCandidate,
	useTraining,
} from "../src/index.js";
import { createAxEngine } from "../src/providers/ax.js";

const artifactRef = "examples/output/router.ts";
const marker = "autocode:generated-region";
const source = [
	"export class Router {",
	`  // ${marker} begin region=router owner=training`,
	'  route(input: string) { return input.includes("invoice") ? "billing" : "fallback"; }',
	`  // ${marker} end region=router`,
	"}",
	"",
].join("\n");
await mkdir("examples/output", { recursive: true });
await writeFile(artifactRef, source, "utf8");
const region = findGeneratedRegion(source, "router", { artifactRef });
const routeToken = defineTrainable("router.route");

const secrets = {
	async get(name: string) {
		return process.env[name];
	},
};

const engine = createAxEngine({
	studentAI: async ({ secrets: provider }) => {
		const apiKey = await provider?.get("OPENAI_API_KEY");
		if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
		return ai({ name: "openai", apiKey });
	},
	program: () => ax("task:string, currentCode:string -> replacement:string"),
	examples: ({ request, currentSource }) =>
		request.evaluations.map(({ result }) => ({
			task: `${request.objective}\nExpected output: ${result.output}`,
			currentCode: currentSource,
			expected: result.output,
		})),
	metric: ({ prediction, example }) =>
		prediction.replacement.includes(String(example["expected"])) ? 1 : 0,
	input: ({ request, currentSource }) => ({ task: request.objective, currentCode: currentSource }),
	replacement: (output) => output.replacement,
});

const training = useTraining({
	engine,
	secrets,
	variables: { environment: "development" },
	concurrency: 4,
});

class Router {
	@training.trainable({ token: routeToken, region })
	route(input: string): string {
		return input.includes("invoice") ? "billing" : "fallback";
	}
}

const router = new Router();
router.route("Where is my invoice?");

const evaluated = await training.evaluate(routeToken, {
	tests: [
		{ id: "billing", input: "Where is my invoice?", assert: [{ type: "equals", value: "billing" }] },
		{ id: "fallback", input: "Reset my password", assert: [{ type: "equals", value: "fallback" }] },
	],
	task: (input) => router.route(input),
	workers: 2,
});

const candidate = await training.optimize({
	token: routeToken,
	objective: "Keep billing routing correct and preserve a fallback",
	artifacts: { [artifactRef]: source },
});
const decision = await evaluatePromotionGate({
	candidate,
	evaluations: evaluated.evaluations,
	conformance: true,
	policy: () => true,
});
const promoted = promoteCandidate({
	artifacts: { [artifactRef]: source },
	candidate,
	regions: training.regions(routeToken),
	decision,
});

await writeFile(artifactRef, promoted.artifacts[artifactRef] as string, "utf8");
