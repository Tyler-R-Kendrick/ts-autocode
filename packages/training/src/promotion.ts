import type { EvaluationResult } from "@agentv/core";
import { z } from "zod";

import type { BoundEvaluation, CandidatePatch } from "./engine.js";
import { parseSetting } from "./errors.js";

const unitInterval = (name: string) => {
	const message = `${name} must be between 0 and 1`;
	return z.number({ error: message }).finite(message).min(0, message).max(1, message);
};
const minScoreThreshold = unitInterval("minScore");
const minPassRateThreshold = unitInterval("minPassRate");

export const defaultMinScore = 0.8;

export const defaultMinPassRate = 1;

export interface PromotionGateInput {
	readonly candidate: CandidatePatch;
	readonly evaluations: readonly BoundEvaluation[];
	readonly conformance: boolean;
	readonly minScore?: number;
	readonly minPassRate?: number;
	readonly policy?: (candidate: CandidatePatch) => boolean | Promise<boolean>;
	readonly gates?: readonly PromotionGate[];
}

export interface PromotionDecision {
	readonly candidateId: string;
	readonly promote: boolean;
	readonly failures: readonly string[];
	readonly meanScore: number;
	readonly passRate: number;
}

export interface PromotionGateContext {
	readonly candidate: CandidatePatch;
	readonly evaluations: readonly BoundEvaluation[];
	readonly results: readonly EvaluationResult[];
	readonly conformance: boolean;
	readonly minScore: number;
	readonly minPassRate: number;
	readonly meanScore: number;
	readonly passRate: number;
}

export type PromotionGate = (
	context: PromotionGateContext,
) => string | readonly string[] | undefined | Promise<string | readonly string[] | undefined>;

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

export async function evaluatePromotionGate(input: PromotionGateInput): Promise<PromotionDecision> {
	const minScore = parseSetting(minScoreThreshold, input.minScore ?? defaultMinScore);
	const minPassRate = parseSetting(minPassRateThreshold, input.minPassRate ?? defaultMinPassRate);
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
		failures: Object.freeze(failures),
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

function average(values: readonly number[]): number {
	return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
