import { check, digest } from "./canonical.js";

export interface RewriteTarget {
	readonly id: string;
	readonly artifactRef: string;
	readonly bodyStart: number;
	readonly bodyEnd: number;
	readonly bodyDigest: string;
	readonly indentation: string;
}

export interface RewriteCandidate {
	readonly id: string;
	readonly target: RewriteTarget;
	readonly implementation: string;
}

export function applyCandidate(source: string, candidate: RewriteCandidate): string {
	const { target } = candidate;
	const current = source.slice(target.bodyStart, target.bodyEnd);
	check(digest(current) === target.bodyDigest, `rewrite target changed after discovery: ${target.id}`);
	const replacement = formatImplementation(candidate.implementation, target.indentation, source);
	return `${source.slice(0, target.bodyStart)}${replacement}${source.slice(target.bodyEnd)}`;
}

export interface RewriteSnapshot {
	readonly rewriteId: string;
	readonly targetId: string;
	readonly artifactRef: string;
	readonly startOffset: number;
	readonly previous: string;
	readonly updated: string;
}

export interface AppliedRewrite {
	readonly source: string;
	readonly snapshot: RewriteSnapshot;
}

export function commitRewrite(source: string, candidate: RewriteCandidate): AppliedRewrite {
	const updated = applyCandidate(source, candidate);
	const previous = source.slice(candidate.target.bodyStart, candidate.target.bodyEnd);
	const updatedLength = updated.length - source.length + previous.length;
	return Object.freeze({
		source: updated,
		snapshot: Object.freeze({
			rewriteId: candidate.id,
			targetId: candidate.target.id,
			artifactRef: candidate.target.artifactRef,
			startOffset: candidate.target.bodyStart,
			previous,
			updated: updated.slice(candidate.target.bodyStart, candidate.target.bodyStart + updatedLength),
		}),
	});
}

export function revertRewrite(source: string, snapshot: RewriteSnapshot): string {
	const endOffset = snapshot.startOffset + snapshot.updated.length;
	check(source.slice(snapshot.startOffset, endOffset) === snapshot.updated, "rewritten method changed before revert");
	return `${source.slice(0, snapshot.startOffset)}${snapshot.previous}${source.slice(endOffset)}`;
}

function formatImplementation(implementation: string, methodIndent: string, source: string): string {
	const indentUnit = methodIndent.includes("\t") || source.includes("\t") ? "\t" : "  ";
	const bodyIndent = `${methodIndent}${indentUnit}`;
	const lines = implementation.split("\n");
	const minimumIndent = Math.min(...lines.filter((line) => line.trim()).map(leadingWhitespace));
	const normalized = lines.map((line) =>
		line.trim() ? `${bodyIndent}${line.slice(Number.isFinite(minimumIndent) ? minimumIndent : 0)}` : "");
	return `\n${normalized.join("\n")}\n${methodIndent}`;
}

function leadingWhitespace(line: string): number {
	return line.length - line.trimStart().length;
}
