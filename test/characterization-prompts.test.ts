import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTrainingRuntime, defineTrainable, discoverInSource } from "../src/index.js";
import type { TrainingLoopInput } from "../src/index.js";
import { verify, verifyJson } from "./support/verify.js";

const mocks = vi.hoisted(() => ({ ax: vi.fn(), optimize: vi.fn(), ai: vi.fn(), forward: vi.fn(), apply: vi.fn() }));

vi.mock("@ax-llm/ax", async (importOriginal) => ({
	...await importOriginal<typeof import("@ax-llm/ax")>(),
	ai: mocks.ai,
	ax: mocks.ax,
	optimize: mocks.optimize,
}));

// Two artifacts nothing else pins, both of which are read by a model rather
// than by code:
//
//   - the promotion rubric handed to the harness judge, which once shipped the
//     literal string "evaluation default" in place of the real threshold;
//   - the Ax program signature derived from the TypeScript method, which is
//     the prompt an optimizer actually receives.
//
// Neither has a natural assertion (they are prose and field descriptors), so
// an approved file is the only review that shows a change to them.

const directory = "test/output/prompts";
const source = `class Router {
	route(input: string, retries = 2, tags?: string[]): string {
		"use training";
		return input;
	}
}
`;

async function fixture(): Promise<string> {
	await mkdir(directory, { recursive: true });
	const file = join(directory, "router.ts");
	await writeFile(file, source, "utf8");
	return file;
}

/** Runs a train() far enough to capture what the loop is handed, then stops. */
async function captureLoopInput(input: Record<string, unknown> = {}): Promise<TrainingLoopInput> {
	const artifact = await fixture();
	let captured: TrainingLoopInput | undefined;
	const training = createTrainingRuntime({
		engine: { id: "characterization", optimize: async () => ({ implementation: "return input;" }) },
		executor: async () => "x",
		source: { files: [artifact] },
		tracing: { enabled: false },
		loop: async (loopInput) => {
			captured = loopInput;
			return { outcome: "exhausted", rounds: [] };
		},
	});
	await training.train({
		trainable: defineTrainable("Router.route").symbol,
		evaluation: {
			tests: [{ id: "a", input: "a", assert: [{ type: "equals", value: "a" }] }],
			task: (value) => value,
			outputDir: `${directory}/agentv`,
		},
		...input,
	}).catch(() => undefined);
	if (captured === undefined) throw new Error("loop was never invoked");
	return captured;
}

describe("promotion rubric handed to the judge", () => {
	it("names resolved thresholds at the defaults", async () => {
		const { rubric, objective } = await captureLoopInput();
		await verify("prompts/rubric-defaults.txt", `objective: ${objective}\nrubric:    ${rubric}\n`);
	});

	it("reflects configured thresholds and a policy", async () => {
		const { rubric } = await captureLoopInput({
			promotion: { minScore: 0.95, minPassRate: 0.5 },
			policy: () => true,
		});
		await verify("prompts/rubric-configured.txt", `${rubric}\n`);
	});

	it("never contains a placeholder where a number belongs", async () => {
		const { rubric } = await captureLoopInput();
		expect(rubric).not.toContain("evaluation default");
		expect(rubric).toMatch(/Minimum evaluation score: [\d.]+\./);
	});
});

describe("Ax program derived from the method signature", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("OPENAI_API_KEY", "test-key");
		mocks.ax.mockReturnValue({ applyOptimization: mocks.apply, forward: mocks.forward });
		mocks.optimize.mockResolvedValue({ optimizedProgram: { optimizerType: "t", converged: true, totalRounds: 1 }, bestScore: 1 });
		mocks.forward.mockResolvedValue({ optimizedMethodImplementation: "return input;" });
	});

	afterEach(() => vi.unstubAllEnvs());

	it("turns parameters into named, typed, described input fields", async () => {
		const { createAxEngine } = await import("../src/providers/ax.js");
		const target = discoverInSource(source, "router.ts")[0]!;
		await createAxEngine().optimize({
			trainableId: target.id,
			objective: "Preserve routing",
			target,
			records: [],
			evaluations: [{
				trainableId: target.id,
				test: { id: "a", input: '["hello",1,["x"]]', assert: [{ type: "equals", value: "hello" }] },
				result: { input: [{ role: "user", content: '["hello",1,["x"]]' }], output: "hello", executionStatus: "ok" } as never,
			}],
			constraints: ["Do not call the network."],
		}, { variables: {} });
		// This object is the prompt. Its description and field types decide what
		// the model is asked for.
		await verifyJson("prompts/ax-program-signature", mocks.ax.mock.calls[0]?.[0]);
	});
});
