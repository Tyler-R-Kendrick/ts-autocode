import { describe, expect, it } from "vitest";

import { createCandidateReview, createEvalRun, createPromotionDecision } from "../src/builders.js";
import { discoverInSource } from "../src/source.js";
import { defineTrainable } from "../src/token.js";
import type { CandidatePatch } from "../src/engine.js";

// These builders exist so that implementing a TrainingLoop never needs a cast.
// Their defaulting rules are the part a consumer will rely on without reading
// the source, so each default is pinned here.

const target = discoverInSource(`class Fixture {
	route(input: string): string {
		"use training";
		return input;
	}
}`, "fixture.ts")[0]!;

const candidate: CandidatePatch = {
	id: "cand-1", trainableId: target.id, engineId: "test", target, implementation: "return input;",
};

describe("createEvalRun", () => {
	it("accepts a token or a symbol as the identity", () => {
		const token = defineTrainable(target.id);
		expect(createEvalRun({ trainable: token }).token.id).toBe(target.id);
		expect(createEvalRun({ trainable: token.symbol }).token.id).toBe(target.id);
	});

	it("defaults to an empty but well-formed AgentV run", () => {
		const run = createEvalRun({ trainable: defineTrainable(target.id) });
		expect(run.evaluations).toEqual([]);
		expect(run.run.results).toEqual([]);
		expect(run.run.summary).toEqual({
			total: 0, passed: 0, failed: 0, executionErrors: 0, durationMs: 0, meanScore: 0,
		});
	});

	it("carries supplied evaluations and freezes the result", () => {
		const evaluations = [{ trainableId: target.id, result: { score: 1 } as never }];
		const run = createEvalRun({ trainable: defineTrainable(target.id), evaluations });
		expect(run.evaluations).toHaveLength(1);
		expect(Object.isFrozen(run)).toBe(true);
		expect(Object.isFrozen(run.evaluations)).toBe(true);
	});

	it("copies the evaluations rather than aliasing the caller's array", () => {
		const evaluations = [{ trainableId: target.id, result: { score: 1 } as never }];
		const run = createEvalRun({ trainable: defineTrainable(target.id), evaluations });
		evaluations.push({ trainableId: target.id, result: { score: 0 } as never });
		expect(run.evaluations).toHaveLength(1);
	});

	it("uses a supplied run verbatim", () => {
		const supplied = { results: [], summary: { total: 7, passed: 7, failed: 0, executionErrors: 0, durationMs: 1, meanScore: 1 } };
		expect(createEvalRun({ trainable: defineTrainable(target.id), run: supplied }).run).toBe(supplied);
	});
});

describe("createPromotionDecision", () => {
	it("promotes by default when no failures are given", () => {
		expect(createPromotionDecision({ candidateId: "c" }))
			.toEqual({ candidateId: "c", promote: true, failures: [], meanScore: 1, passRate: 1 });
	});

	it("refuses by default when failures are given", () => {
		expect(createPromotionDecision({ candidateId: "c", failures: ["bad"] }))
			.toEqual({ candidateId: "c", promote: false, failures: ["bad"], meanScore: 0, passRate: 0 });
	});

	it("lets an explicit promote override the inference in both directions", () => {
		expect(createPromotionDecision({ candidateId: "c", failures: ["bad"], promote: true }).promote).toBe(true);
		expect(createPromotionDecision({ candidateId: "c", promote: false }).promote).toBe(false);
		// And the derived scores follow the explicit flag, not the failures.
		expect(createPromotionDecision({ candidateId: "c", failures: ["bad"], promote: true }).meanScore).toBe(1);
	});

	it("honors explicit scores, including zero", () => {
		expect(createPromotionDecision({ candidateId: "c", meanScore: 0, passRate: 0.5 }))
			.toMatchObject({ meanScore: 0, passRate: 0.5 });
	});

	it("freezes the decision and its failures", () => {
		const decision = createPromotionDecision({ candidateId: "c", failures: ["x"] });
		expect(Object.isFrozen(decision)).toBe(true);
		expect(Object.isFrozen(decision.failures)).toBe(true);
	});
});

describe("createCandidateReview", () => {
	it("derives both halves from the candidate alone", () => {
		const review = createCandidateReview({ candidate });
		expect(review.decision.candidateId).toBe(candidate.id);
		expect(review.decision.promote).toBe(true);
		expect(review.verification.token.id).toBe(target.id);
	});

	it("threads failures into the derived decision", () => {
		expect(createCandidateReview({ candidate, failures: ["nope"] }).decision)
			.toMatchObject({ promote: false, failures: ["nope"] });
	});

	it("threads evaluations into the derived verification", () => {
		const review = createCandidateReview({
			candidate,
			evaluations: [{ trainableId: target.id, result: { score: 1 } as never }],
		});
		expect(review.verification.evaluations).toHaveLength(1);
	});

	it("prefers an explicitly supplied verification or decision", () => {
		const verification = createEvalRun({ trainable: defineTrainable(target.id) });
		const decision = createPromotionDecision({ candidateId: "other", promote: false });
		const review = createCandidateReview({ candidate, verification, decision, failures: ["ignored"] });
		expect(review.verification).toBe(verification);
		expect(review.decision).toBe(decision);
		expect(review.decision.failures).toEqual([]);
	});

	it("freezes the review", () => {
		expect(Object.isFrozen(createCandidateReview({ candidate }))).toBe(true);
	});
});
