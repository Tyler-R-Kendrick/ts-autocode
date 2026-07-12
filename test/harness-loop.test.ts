import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { discoverInSource } from "ts-autocode-training";

import type {
	CandidatePatch,
	CandidateReview,
	TrainableEvalRun,
} from "../src/index.js";
import { defineTrainable } from "../src/index.js";
import { createHarnessLoop } from "../src/providers/harness.js";

const source = `class Router {
  route(input: string): string {
    "use training";
    return input;
  }
}`;
const target = discoverInSource(source, "src/router.ts")[0]!;
const token = defineTrainable(target.id);

function candidate(id: string): CandidatePatch {
	return { id, trainableId: target.id, engineId: "test", target, implementation: "return input;" };
}

function review(promote: boolean, failures: readonly string[] = []): CandidateReview {
	return {
		verification: { token, run: {}, evaluations: [] } as unknown as TrainableEvalRun,
		decision: { candidateId: "irrelevant", promote, failures, meanScore: Number(promote), passRate: Number(promote) },
	};
}

async function outputDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "ts-autocode-harness-loop-"));
}

describe("harness training loop", () => {
	it("accepts a candidate only after adversarial re-verification", async () => {
		const labels: string[] = [];
		const run = await createHarnessLoop()({
			trainableId: target.id,
			objective: "keep routing",
			rubric: "Candidate must pass evals.",
			outputDir: await outputDir(),
			propose: async ({ round }) => candidate(`candidate-${round}`),
			review: async (_candidate, { label }) => {
				labels.push(label);
				return review(true);
			},
		});

		expect(run.outcome).toBe("ready");
		expect(run.rounds).toHaveLength(1);
		expect(run.rounds[0]?.decision.promote).toBe(true);
		expect(labels).toEqual(["candidate-1", "adversary-candidate-1"]);
	});

	it("feeds rejection failures back and stalls on a repeated candidate", async () => {
		const feedbackByRound: string[][] = [];
		const run = await createHarnessLoop()({
			trainableId: target.id,
			objective: "keep routing",
			rubric: "Candidate must pass evals.",
			outputDir: await outputDir(),
			propose: async ({ feedback }) => {
				feedbackByRound.push([...feedback]);
				return candidate("same-candidate");
			},
			review: async () => review(false, ["mean score below threshold"]),
		});

		expect(run.outcome).toBe("stalled");
		expect(run.rounds).toHaveLength(1);
		expect(feedbackByRound).toEqual([[], ["mean score below threshold"]]);
	});

	it("revises the rubric when the adversary breaks an accepted candidate", async () => {
		const reviews = [review(true), review(false, ["fails on empty input"]), review(true), review(true)];
		const feedbackByRound: string[][] = [];
		const run = await createHarnessLoop()({
			trainableId: target.id,
			objective: "keep routing",
			rubric: "Candidate must pass evals.",
			outputDir: await outputDir(),
			propose: async ({ round, feedback }) => {
				feedbackByRound.push([...feedback]);
				return candidate(`candidate-${round}`);
			},
			review: async () => reviews.shift()!,
		});

		expect(run.outcome).toBe("ready");
		expect(run.rounds).toHaveLength(2);
		expect(feedbackByRound).toEqual([[], ["fails on empty input"]]);
	});
});
