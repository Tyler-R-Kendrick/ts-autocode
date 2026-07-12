import type { EvaluationResult } from "@agentv/core";

import type { BoundEvaluation, CandidatePatch } from "./engine.js";

export interface PromotionGateInput {
	readonly candidate: CandidatePatch;
	readonly evaluations: readonly BoundEvaluation[];
	readonly conformance: boolean;
	readonly minScore?: number;
	readonly minPassRate?: number;
	readonly policy?: (candidate: CandidatePatch) => boolean | Promise<boolean>;
}

export interface PromotionDecision {
	readonly candidateId: string;
	readonly promote: boolean;
	readonly failures: readonly string[];
	readonly meanScore: number;
	readonly passRate: number;
}

export async function evaluatePromotionGate(input: PromotionGateInput): Promise<PromotionDecision> {
	const minScore = input.minScore ?? 0.8;
	const minPassRate = input.minPassRate ?? 1;
	assertUnitInterval(minScore, "minScore");
	assertUnitInterval(minPassRate, "minPassRate");
	const mismatched = input.evaluations.some((evaluation) => evaluation.trainableId !== input.candidate.trainableId);
	const wrongCandidate = input.evaluations.some((evaluation) =>
		evaluation.trainableId === input.candidate.trainableId && evaluation.candidateId !== input.candidate.id
	);
	const results = input.evaluations
		.filter((evaluation) =>
			evaluation.trainableId === input.candidate.trainableId && evaluation.candidateId === input.candidate.id
		)
		.map((evaluation) => evaluation.result);
	const meanScore = average(results.map((result) => result.score));
	const passRate = average(results.map((result) => Number(passed(result, minScore))));
	const failures: string[] = [];
	if (!input.conformance) failures.push("conformance failed");
	if (mismatched) failures.push("AgentV evaluations must match the candidate trainable id");
	if (wrongCandidate) failures.push("AgentV evaluations must be run against the candidate");
	if (results.length === 0) failures.push("candidate-specific AgentV evaluations are required");
	if (results.some((result) => result.executionStatus === "execution_error")) {
		failures.push("AgentV evaluation had execution errors");
	}
	if (meanScore < minScore) failures.push(`mean AgentV score ${meanScore} is below ${minScore}`);
	if (passRate < minPassRate) failures.push(`AgentV pass rate ${passRate} is below ${minPassRate}`);
	if (input.policy && !(await input.policy(input.candidate))) failures.push("promotion policy refused candidate");
	return Object.freeze({ candidateId: input.candidate.id, promote: failures.length === 0, failures, meanScore, passRate });
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
