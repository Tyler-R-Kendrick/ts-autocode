import { applyCandidate, type RewriteCandidate } from "./apply.js";
import { check } from "./canonical.js";

/** Structural subset of ts-autocode-training's PromotionDecision. */
export interface RewriteApproval {
	readonly candidateId: string;
	readonly promote: boolean;
}

export interface PromotionSnapshot {
	readonly candidateId: string;
	readonly trainableId: string;
	readonly artifactRef: string;
	readonly startOffset: number;
	readonly previous: string;
	readonly promoted: string;
}

export interface PromotionResult {
	readonly source: string;
	readonly snapshot: PromotionSnapshot;
}

export function promoteCandidate({
	source,
	candidate,
	decision,
}: {
	source: string;
	candidate: RewriteCandidate;
	decision: RewriteApproval;
}): PromotionResult {
	check(decision.promote && decision.candidateId === candidate.id, "candidate has not passed the promotion gate");
	const updated = applyCandidate(source, candidate);
	const previous = source.slice(candidate.target.bodyStart, candidate.target.bodyEnd);
	const promotedLength = updated.length - source.length + previous.length;
	return Object.freeze({
		source: updated,
		snapshot: Object.freeze({
			candidateId: candidate.id,
			trainableId: candidate.trainableId,
			artifactRef: candidate.target.artifactRef,
			startOffset: candidate.target.bodyStart,
			previous,
			promoted: updated.slice(candidate.target.bodyStart, candidate.target.bodyStart + promotedLength),
		}),
	});
}

export function revertPromotion(source: string, snapshot: PromotionSnapshot): string {
	const endOffset = snapshot.startOffset + snapshot.promoted.length;
	check(source.slice(snapshot.startOffset, endOffset) === snapshot.promoted, "promoted method changed before revert");
	return `${source.slice(0, snapshot.startOffset)}${snapshot.previous}${source.slice(endOffset)}`;
}
