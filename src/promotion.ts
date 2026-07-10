import type { EvaluationResult } from "@agentv/core";

import { applyCandidate, type BoundEvaluation, type CandidatePatch } from "./engine.js";
import type { GeneratedRegion } from "./region.js";

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

export interface PromotionSnapshot {
	readonly candidateId: string;
	readonly edits: readonly {
		readonly artifactRef: string;
		readonly regionId: string;
		readonly startOffset: number;
		readonly previous: string;
		readonly promoted: string;
	}[];
}

export interface PromotionResult {
	readonly artifacts: Readonly<Record<string, string>>;
	readonly snapshot: PromotionSnapshot;
}

/** Three-lens gate: conformance, AgentV evaluation, and policy. */
export async function evaluatePromotionGate(input: PromotionGateInput): Promise<PromotionDecision> {
	const minScore = input.minScore ?? 0.8;
	const minPassRate = input.minPassRate ?? 1;
	assertUnitInterval(minScore, "minScore");
	assertUnitInterval(minPassRate, "minPassRate");
	const hasMismatchedEvaluations = input.evaluations.some(
		(evaluation) => evaluation.trainableId !== input.candidate.trainableId,
	);
	const results = input.evaluations
		.filter((evaluation) => evaluation.trainableId === input.candidate.trainableId)
		.map((evaluation) => evaluation.result);
	const meanScore = average(results.map((result) => result.score));
	const passRate = average(results.map((result) => Number(passed(result, minScore))));
	const failures: string[] = [];
	if (!input.conformance) failures.push("conformance failed");
	if (hasMismatchedEvaluations) failures.push("AgentV evaluations must match the candidate trainable id");
	if (results.length === 0) failures.push("AgentV evaluations are required");
	if (results.some((result) => result.executionStatus === "execution_error")) {
		failures.push("AgentV evaluation had execution errors");
	}
	if (meanScore < minScore) failures.push(`mean AgentV score ${meanScore} is below ${minScore}`);
	if (passRate < minPassRate) failures.push(`AgentV pass rate ${passRate} is below ${minPassRate}`);
	if (input.policy && !(await input.policy(input.candidate))) failures.push("promotion policy refused candidate");
	return Object.freeze({
		candidateId: input.candidate.id,
		promote: failures.length === 0,
		failures,
		meanScore,
		passRate,
	});
}

export function promoteCandidate({
	artifacts,
	candidate,
	regions,
	decision,
}: {
	artifacts: Readonly<Record<string, string>>;
	candidate: CandidatePatch;
	regions: readonly GeneratedRegion[];
	decision: PromotionDecision;
}): PromotionResult {
	if (!decision.promote || decision.candidateId !== candidate.id) {
		throw new Error("candidate has not passed the promotion gate");
	}
	const promoted = applyCandidate(artifacts, candidate, regions);
	const byId = new Map(regions.map((region) => [region.regionId, region]));
	const snapshot = candidate.edits.map((edit) => {
		const region = byId.get(edit.regionId) as GeneratedRegion;
		const source = artifacts[edit.artifactRef] as string;
		const shift = candidate.edits
			.filter((other) => other.artifactRef === edit.artifactRef && other.startOffset < edit.startOffset)
			.reduce((sum, other) => sum + normalizedReplacement(source, other).length - (other.endOffset - other.startOffset), 0);
		return {
			artifactRef: edit.artifactRef,
			regionId: edit.regionId,
			startOffset: edit.startOffset + shift,
			previous: source.slice(region.startOffset, region.endOffset),
			promoted: normalizedReplacement(source, edit),
		};
	});
	return {
		artifacts: promoted,
		snapshot: Object.freeze({ candidateId: candidate.id, edits: snapshot }),
	};
}

export function revertPromotion(
	artifacts: Readonly<Record<string, string>>,
	snapshot: PromotionSnapshot,
): Readonly<Record<string, string>> {
	const result = { ...artifacts };
	const byArtifact = new Map<string, PromotionSnapshot["edits"][number][]>();
	for (const edit of snapshot.edits) {
		const edits = byArtifact.get(edit.artifactRef) ?? [];
		edits.push(edit);
		byArtifact.set(edit.artifactRef, edits);
	}
	for (const [artifactRef, edits] of byArtifact) {
		let source = result[artifactRef];
		if (source === undefined) throw new Error(`artifact is missing: ${artifactRef}`);
		for (const edit of [...edits].sort((left, right) => right.startOffset - left.startOffset)) {
			const endOffset = edit.startOffset + edit.promoted.length;
			if (source.slice(edit.startOffset, endOffset) !== edit.promoted) {
				throw new Error(`promoted region changed before revert: ${edit.regionId}`);
			}
			source = `${source.slice(0, edit.startOffset)}${edit.previous}${source.slice(endOffset)}`;
		}
		result[artifactRef] = source;
	}
	return Object.freeze(result);
}

function passed(result: EvaluationResult, threshold: number): boolean {
	return result.executionStatus !== "execution_error" && result.score >= threshold;
}

function normalizedReplacement(source: string, edit: CandidatePatch["edits"][number]): string {
	const previous = source.slice(edit.startOffset, edit.endOffset);
	return previous.endsWith("\n") && !edit.replacement.endsWith("\n")
		? `${edit.replacement}\n`
		: edit.replacement;
}

function assertUnitInterval(value: number, name: string): void {
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new TypeError(`${name} must be between 0 and 1`);
	}
}

function average(values: readonly number[]): number {
	return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
