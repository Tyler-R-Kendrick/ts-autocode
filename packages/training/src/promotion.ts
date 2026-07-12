import type { EvaluationResult } from "@agentv/core";

import type { BoundEvaluation, CandidatePatch } from "./engine.js";

export interface PromotionGateInput {
	readonly candidate: CandidatePatch;
	readonly evaluations: readonly BoundEvaluation[];
	readonly conformance: boolean;
	readonly minScore?: number;
	readonly minPassRate?: number;
	readonly policy?: (candidate: CandidatePatch) => boolean | Promise<boolean>;
	/** Extra gates run after the standard set; each failure they return blocks
	 * promotion. The standard invariants always run — extension adds rules, it
	 * cannot waive them. */
	readonly gates?: readonly PromotionGate[];
}

export interface PromotionDecision {
	readonly candidateId: string;
	readonly promote: boolean;
	readonly failures: readonly string[];
	readonly meanScore: number;
	readonly passRate: number;
}

/** Everything a gate may inspect. Derived once per decision and shared by all
 * gates, so rules stay pure functions over the same facts. */
export interface PromotionGateContext {
	readonly candidate: CandidatePatch;
	/** Every submitted evaluation, including ones bound to other targets. */
	readonly evaluations: readonly BoundEvaluation[];
	/** Results proven to be bound to this candidate; only these carry weight. */
	readonly results: readonly EvaluationResult[];
	readonly conformance: boolean;
	readonly minScore: number;
	readonly minPassRate: number;
	readonly meanScore: number;
	readonly passRate: number;
}

/** One promotion rule: inspect the context and return the failure(s) it sees,
 * or `undefined` to pass. Rules never mutate and never see each other. */
export type PromotionGate = (
	context: PromotionGateContext,
) => string | readonly string[] | undefined | Promise<string | readonly string[] | undefined>;

/** The standard rules every candidate must clear, in reporting order. */
export const defaultPromotionGates: readonly PromotionGate[] = [
	({ conformance }) =>
		conformance ? undefined : "conformance failed",
	({ candidate, evaluations }) =>
		evaluations.every((evaluation) => evaluation.trainableId === candidate.trainableId)
			? undefined
			: "AgentV evaluations must match the candidate trainable id",
	({ candidate, evaluations }) =>
		evaluations.every((evaluation) => evaluation.trainableId !== candidate.trainableId || evaluation.candidateId === candidate.id)
			? undefined
			: "AgentV evaluations must be run against the candidate",
	({ results }) =>
		results.length > 0 ? undefined : "candidate-specific AgentV evaluations are required",
	({ results }) =>
		results.every((result) => result.executionStatus !== "execution_error")
			? undefined
			: "AgentV evaluation had execution errors",
	({ meanScore, minScore }) =>
		meanScore >= minScore ? undefined : `mean AgentV score ${meanScore} is below ${minScore}`,
	({ passRate, minPassRate }) =>
		passRate >= minPassRate ? undefined : `AgentV pass rate ${passRate} is below ${minPassRate}`,
];

/** Runs the standard gates, the configured policy, and any extension gates
 * over one shared context; the collected failures decide promotion. */
export async function evaluatePromotionGate(input: PromotionGateInput): Promise<PromotionDecision> {
	const minScore = input.minScore ?? 0.8;
	const minPassRate = input.minPassRate ?? 1;
	assertUnitInterval(minScore, "minScore");
	assertUnitInterval(minPassRate, "minPassRate");
	const results = input.evaluations
		.filter((evaluation) => evaluation.trainableId === input.candidate.trainableId && evaluation.candidateId === input.candidate.id)
		.map((evaluation) => evaluation.result);
	const context: PromotionGateContext = Object.freeze({
		candidate: input.candidate,
		evaluations: input.evaluations,
		results,
		conformance: input.conformance,
		minScore,
		minPassRate,
		meanScore: average(results.map((result) => result.score)),
		passRate: average(results.map((result) => Number(passed(result, minScore)))),
	});
	const gates = [
		...defaultPromotionGates,
		...(input.policy === undefined ? [] : [policyGate(input.policy)]),
		...(input.gates ?? []),
	];
	const failures = (await Promise.all(gates.map((gate) => gate(context))))
		.flatMap((failure) => failure === undefined ? [] : typeof failure === "string" ? [failure] : [...failure]);
	return Object.freeze({
		candidateId: input.candidate.id,
		promote: failures.length === 0,
		failures,
		meanScore: context.meanScore,
		passRate: context.passRate,
	});
}

function policyGate(policy: (candidate: CandidatePatch) => boolean | Promise<boolean>): PromotionGate {
	return async ({ candidate }) => (await policy(candidate)) ? undefined : "promotion policy refused candidate";
}

function passed(result: EvaluationResult, threshold: number): boolean {
	return result.executionStatus !== "execution_error" && result.score >= threshold;
}

function assertUnitInterval(value: number, name: string): void {
	if (!Number.isFinite(value) || value < 0 || value > 1) throw new TypeError(`${name} must be between 0 and 1`);
}

function average(values: readonly number[]): number {
	return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
