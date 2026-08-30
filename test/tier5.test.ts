import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	createCandidateReview,
	createEvalRun,
	createPromotionDecision,
	createTrainingRuntime,
	defineTrainable,
	evaluationArgs,
	type CandidatePatch,
	type ImplementationExecutor,
} from "../src/index.js";
import { discoverInSource } from "ts-autocode-training";

const source = `class Fixture {
	route(input: string): string {
		"use training";
		return input;
	}
}
`;
const target = discoverInSource(source, "fixture.ts")[0]!;
const candidate: CandidatePatch = {
	id: "cand-1", trainableId: target.id, engineId: "test", target, implementation: "return input;",
};

describe("builders", () => {
	// A custom TrainingLoop must return a CandidateReview containing a
	// TrainableEvalRun that only the internals could produce, so both this
	// repo's tests and any consumer had to write `as unknown as`.
	it("builds a review with no cast at all", () => {
		const review = createCandidateReview({ candidate, failures: ["nope"] });
		expect(review.decision.promote).toBe(false);
		expect(review.decision.failures).toEqual(["nope"]);
		expect(review.verification.token.id).toBe(target.id);
		expect(review.verification.run.summary.total).toBe(0);
	});

	it("promotes by default when there are no failures", () => {
		expect(createCandidateReview({ candidate }).decision).toMatchObject({
			promote: true, meanScore: 1, passRate: 1,
		});
	});

	it("lets the caller supply real evidence", () => {
		const verification = createEvalRun({
			trainable: defineTrainable(target.id),
			evaluations: [{ trainableId: target.id, result: { score: 1 } as never }],
		});
		const review = createCandidateReview({
			candidate,
			verification,
			decision: createPromotionDecision({ candidateId: candidate.id, promote: true, meanScore: 0.9 }),
		});
		expect(review.verification.evaluations).toHaveLength(1);
		expect(review.decision.meanScore).toBe(0.9);
	});
});

describe("evaluation argument decoding", () => {
	it("guesses by default, ambiguously", () => {
		expect(evaluationArgs('["a","b"]')).toEqual(["a", "b"]);
		expect(evaluationArgs("plain")).toEqual(["plain"]);
		// The ambiguity the escape hatch exists for: a trainable taking the
		// literal string "[1,2]" receives two numbers instead.
		expect(evaluationArgs("[1,2]")).toEqual([1, 2]);
	});

	it("lets a caller decode arguments explicitly", async () => {
		const directory = "test/output/tier5";
		await mkdir(directory, { recursive: true });
		const artifact = join(directory, "fixture.ts");
		await writeFile(artifact, source, "utf8");

		const seen: unknown[][] = [];
		const executor: ImplementationExecutor = async (_target, _implementation, args) => {
			seen.push([...args]);
			return String(args[0]);
		};
		const training = createTrainingRuntime({
			engine: { id: "x", optimize: async () => ({ implementation: "return input;" }) },
			executor,
			source: { files: [artifact] },
			tracing: { enabled: false },
			// Pass the raw string through rather than letting JSON.parse split it.
			execution: { decodeArgs: (input) => [input] },
		});
		await training.train({
			trainable: defineTrainable("Fixture.route").symbol,
			evaluation: {
				tests: [{ id: "a", input: "[1,2]", assert: [{ type: "equals", value: "[1,2]" }] }],
				task: (input) => input,
				outputDir: `${directory}/agentv`,
			},
			rounds: { max: 1 },
		});
		expect(seen[0]).toEqual(["[1,2]"]);
	}, 30_000);
});
