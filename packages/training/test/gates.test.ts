import type { EvaluationResult } from "@agentv/core";
import { describe, expect, it } from "vitest";

import { defaultPromotionGates, evaluatePromotionGate } from "../src/promotion.js";
import { discoverInSource } from "../src/source.js";
import type { BoundEvaluation, CandidatePatch } from "../src/engine.js";

// Each standard promotion gate, pinned individually.
//
// Mutation testing showed 30 surviving mutants in promotion.ts: replacing an
// entire gate with `() => undefined` (so that rule never fails) left the
// suite green. The tests asserted that a bad candidate was refused, but not
// *which* rule refused it, so any single rule could be deleted undetected.
//
// This is the module that decides whether generated code is written into
// someone's source file. Every rule needs a case where it, and only it, is the
// reason for refusal.

const target = discoverInSource(`class Fixture {
	route(input: string): string {
		"use training";
		return input;
	}
}`, "fixture.ts")[0]!;

const candidate: CandidatePatch = {
	id: "cand-1", trainableId: target.id, engineId: "gates", target, implementation: "return input;",
};

function result(score: number, executionStatus: EvaluationResult["executionStatus"] = "ok"): EvaluationResult {
	return { testId: "t", score, executionStatus, output: "" } as unknown as EvaluationResult;
}

/** An evaluation bound to this candidate, which is what the gate counts. */
function bound(score: number, executionStatus?: EvaluationResult["executionStatus"]): BoundEvaluation {
	return { trainableId: target.id, candidateId: candidate.id, result: result(score, executionStatus) };
}

/** A gate input that passes everything, so a single override isolates one rule. */
function passing(overrides: Partial<Parameters<typeof evaluatePromotionGate>[0]> = {}) {
	return {
		candidate,
		evaluations: [bound(1)],
		conformance: true,
		minScore: 0.8,
		minPassRate: 1,
		...overrides,
	};
}

describe("the standard gate set", () => {
	it("passes when nothing is wrong, so each failure below is isolated", async () => {
		const decision = await evaluatePromotionGate(passing());
		expect(decision).toMatchObject({ promote: true, failures: [] });
	});

	it("exposes its rules so extensions can be composed with them", () => {
		expect(defaultPromotionGates.length).toBeGreaterThan(0);
	});
});

describe("each rule refuses on its own", () => {
	it("conformance: refuses a candidate whose source did not validate", async () => {
		const decision = await evaluatePromotionGate(passing({ conformance: false }));
		expect(decision.failures).toContain("conformance failed");
		expect(decision.promote).toBe(false);
	});

	it("binding: refuses evaluations belonging to another trainable", async () => {
		const decision = await evaluatePromotionGate(passing({
			evaluations: [{ ...bound(1), trainableId: "Other.method" as typeof target.id }],
		}));
		expect(decision.failures).toContain("AgentV evaluations must match the candidate trainable id");
	});

	it("binding: refuses evaluations not run against this candidate", async () => {
		const decision = await evaluatePromotionGate(passing({
			evaluations: [{ ...bound(1), candidateId: "a-different-candidate" }],
		}));
		expect(decision.failures).toContain("AgentV evaluations must be run against the candidate");
	});

	it("evidence: refuses a candidate with no candidate-bound results at all", async () => {
		const decision = await evaluatePromotionGate(passing({ evaluations: [] }));
		expect(decision.failures).toContain("candidate-specific AgentV evaluations are required");
	});

	it("execution: refuses when any evaluation failed to run", async () => {
		const decision = await evaluatePromotionGate(passing({
			evaluations: [bound(1), bound(1, "execution_error")],
		}));
		expect(decision.failures).toContain("AgentV evaluation had execution errors");
	});

	it("score: refuses when the mean is below the threshold, naming both numbers", async () => {
		const decision = await evaluatePromotionGate(passing({
			evaluations: [bound(0.5)], minPassRate: 0,
		}));
		expect(decision.failures).toContain("mean AgentV score 0.5 is below 0.8");
	});

	it("score: accepts a mean exactly at the threshold", async () => {
		const decision = await evaluatePromotionGate(passing({ evaluations: [bound(0.8)], minPassRate: 0 }));
		expect(decision.failures.some((failure) => failure.includes("mean AgentV score"))).toBe(false);
	});

	it("pass rate: refuses when too few cases passed, naming both numbers", async () => {
		// A case counts as passed when its own score clears `minScore`. Scores
		// of 1 and 0.3 against a 0.5 threshold give a mean of 0.65 (which
		// clears it) and a pass rate of 0.5, which does not. Only the
		// pass-rate rule fires.
		const decision = await evaluatePromotionGate(passing({
			evaluations: [bound(1), bound(0.3)], minScore: 0.5,
		}));
		expect(decision.failures).toContain("AgentV pass rate 0.5 is below 1");
		expect(decision.failures.some((failure) => failure.includes("mean AgentV score"))).toBe(false);
	});

	it("pass rate: accepts a rate exactly at the threshold", async () => {
		const decision = await evaluatePromotionGate(passing({
			evaluations: [bound(1), bound(0.3)], minScore: 0.5, minPassRate: 0.5,
		}));
		expect(decision.promote).toBe(true);
	});

	it("policy: refuses when the configured policy says no", async () => {
		const decision = await evaluatePromotionGate(passing({ policy: () => false }));
		expect(decision.failures).toContain("promotion policy refused candidate");
	});

	it("policy: accepts when it says yes, and awaits an async one", async () => {
		expect((await evaluatePromotionGate(passing({ policy: () => true }))).promote).toBe(true);
		expect((await evaluatePromotionGate(passing({ policy: async () => true }))).promote).toBe(true);
		expect((await evaluatePromotionGate(passing({ policy: async () => false }))).promote).toBe(false);
	});
});

describe("extension gates", () => {
	it("collects a failure string from an extra gate", async () => {
		const decision = await evaluatePromotionGate(passing({ gates: [() => "extra refused"] }));
		expect(decision.failures).toContain("extra refused");
	});

	it("collects several failures from one gate", async () => {
		const decision = await evaluatePromotionGate(passing({ gates: [() => ["first", "second"]] }));
		expect(decision.failures).toContain("first");
		expect(decision.failures).toContain("second");
	});

	it("treats undefined as a pass", async () => {
		expect((await evaluatePromotionGate(passing({ gates: [() => undefined] }))).promote).toBe(true);
	});

	it("awaits an async gate", async () => {
		const decision = await evaluatePromotionGate(passing({ gates: [async () => "async refused"] }));
		expect(decision.failures).toContain("async refused");
	});

	it("cannot waive a standard rule", async () => {
		// Extension adds rules; it never subtracts them.
		const decision = await evaluatePromotionGate(passing({
			conformance: false, gates: [() => undefined],
		}));
		expect(decision.promote).toBe(false);
		expect(decision.failures).toContain("conformance failed");
	});

	it("sees the same derived context every standard rule sees", async () => {
		let seen: { meanScore: number; passRate: number; minScore: number } | undefined;
		await evaluatePromotionGate(passing({
			evaluations: [bound(1), bound(0)],
			minScore: 0.5,
			minPassRate: 0,
			gates: [(context) => { seen = context; return undefined; }],
		}));
		expect(seen?.meanScore).toBe(0.5);
		expect(seen?.passRate).toBe(0.5);
		expect(seen?.minScore).toBe(0.5);
	});
});

describe("the decision it reports", () => {
	it("reports every failure it found, not just the first", async () => {
		const decision = await evaluatePromotionGate(passing({
			conformance: false, evaluations: [], policy: () => false,
		}));
		expect(decision.failures.length).toBeGreaterThanOrEqual(3);
	});

	it("names the candidate it decided about", async () => {
		expect((await evaluatePromotionGate(passing())).candidateId).toBe(candidate.id);
	});

	it("reports zero aggregates when there is nothing to average", async () => {
		const decision = await evaluatePromotionGate(passing({ evaluations: [] }));
		expect(decision.meanScore).toBe(0);
		expect(decision.passRate).toBe(0);
	});

	it("counts an execution error as a failed case for the pass rate", async () => {
		const decision = await evaluatePromotionGate(passing({
			evaluations: [bound(1), bound(1, "execution_error")], minScore: 0, minPassRate: 0,
		}));
		expect(decision.passRate).toBe(0.5);
	});

	it("freezes the decision and its failures", async () => {
		const decision = await evaluatePromotionGate(passing({ conformance: false }));
		expect(Object.isFrozen(decision)).toBe(true);
		expect(Object.isFrozen(decision.failures)).toBe(true);
	});

	it("ignores evaluations bound to other candidates when averaging", async () => {
		const decision = await evaluatePromotionGate(passing({
			evaluations: [bound(1), { ...bound(0), candidateId: "another" }],
		}));
		// The foreign evaluation is refused by the binding rule and excluded
		// from the aggregate, rather than dragging the mean down silently.
		expect(decision.meanScore).toBe(1);
	});
});

describe("rules that only mixed evidence can pin", () => {
	// These cases exist because mutation testing showed the rules below could be
	// broken undetected. With a single evaluation, `every` and `some` are
	// indistinguishable, and a boundary score never sits exactly on the
	// threshold. Each case below is the minimum evidence that tells them apart.

	it("binding: one foreign evaluation among valid ones is enough to refuse", async () => {
		// `every` vs `some`: with one evaluation these agree, so the mix matters.
		const decision = await evaluatePromotionGate(passing({
			evaluations: [bound(1), { ...bound(1), trainableId: "Other.method" as typeof target.id }],
		}));
		expect(decision.failures).toContain("AgentV evaluations must match the candidate trainable id");
		expect(decision.promote).toBe(false);
	});

	it("binding: one evaluation from another candidate is enough to refuse", async () => {
		const decision = await evaluatePromotionGate(passing({
			evaluations: [bound(1), { ...bound(1), candidateId: "another-candidate" }],
		}));
		expect(decision.failures).toContain("AgentV evaluations must be run against the candidate");
		expect(decision.promote).toBe(false);
	});

	it("binding: an evaluation for another trainable is excused from the candidate check", async () => {
		// The second rule reads "not this trainable, OR bound to this candidate".
		// Dropping the left side would make a foreign-trainable evaluation fail
		// the candidate rule too, hiding which rule actually refused.
		const foreign = { ...bound(1), trainableId: "Other.method" as typeof target.id, candidateId: "elsewhere" };
		const decision = await evaluatePromotionGate(passing({ evaluations: [bound(1), foreign] }));
		expect(decision.failures).toContain("AgentV evaluations must match the candidate trainable id");
		expect(decision.failures).not.toContain("AgentV evaluations must be run against the candidate");
	});

	it("aggregates: an evaluation for another trainable is excluded even when its candidate id matches", async () => {
		// Both halves of the filter matter. Dropping the trainable half would let
		// a foreign trainable's score into this candidate's mean.
		const foreign = { ...bound(0), trainableId: "Other.method" as typeof target.id };
		const decision = await evaluatePromotionGate(passing({ evaluations: [bound(1), foreign] }));
		expect(decision.meanScore).toBe(1);
	});

	it("pass rate: a score exactly at the threshold counts as passed", async () => {
		// `>=` versus `>` on the boundary. At 0.8 with a 0.8 threshold the case
		// passes, so the pass rate is 1 and nothing refuses.
		const decision = await evaluatePromotionGate(passing({ evaluations: [bound(0.8)] }));
		expect(decision.passRate).toBe(1);
		expect(decision.promote).toBe(true);
	});

	it("pass rate: a score a hair under the threshold does not count", async () => {
		// Against the same 0.8 threshold the case does not pass, so the rate is 0.
		const decision = await evaluatePromotionGate(passing({ evaluations: [bound(0.7999)] }));
		expect(decision.passRate).toBe(0);
	});
});
