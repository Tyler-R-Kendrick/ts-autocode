import { readFile, writeFile } from "node:fs/promises";

import { ai, ax } from "@ax-llm/ax";

import { applyCandidate, findGeneratedRegion, optimizeRegions } from "../src/index.js";

const artifactRef = "examples/router.ts";
const source = await readFile(artifactRef, "utf8");
const region = findGeneratedRegion(source, "router", { artifactRef });
const apiKey = process.env["OPENAI_API_KEY"];
if (!apiKey) throw new Error("Set OPENAI_API_KEY before running this example");
const studentAI = ai({ name: "openai", apiKey });

const candidate = await optimizeRegions(
	{
		artifacts: { [artifactRef]: source },
		regions: [region],
		data: {
			task: "Improve routing while preserving the function signature",
			examples: [
				{ input: "Where is my invoice?", expected: "billing" },
				{ input: "Reset my password", expected: "fallback" },
			],
		},
	},
	{
		studentAI,
		program: () => ax("task:string, currentCode:string -> replacement:string"),
		examples: ({ currentSource, data }) =>
			data.examples.map((example) => ({
				task: `${data.task}\nInput: ${example.input}`,
				currentCode: currentSource,
				expected: example.expected,
			})),
		metric: ({ prediction, example }) =>
			prediction.replacement.includes(String(example["expected"])) ? 1 : 0,
		input: ({ currentSource, data }) => ({ task: data.task, currentCode: currentSource }),
		replacement: (output) => output.replacement,
	},
);

const updated = applyCandidate({ [artifactRef]: source }, candidate, [region]);
await writeFile(artifactRef, updated[artifactRef] as string, "utf8");
