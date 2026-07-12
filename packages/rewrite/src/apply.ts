import { check, digest } from "./canonical.js";

/** The discovered method-body span a candidate may replace. Any discovery that
 * produces these fields can drive a rewrite. */
export interface RewriteTarget {
	readonly id: string;
	readonly artifactRef: string;
	readonly bodyStart: number;
	readonly bodyEnd: number;
	readonly bodyDigest: string;
	readonly indentation: string;
}

/** A proposed replacement for a target's method body. */
export interface RewriteCandidate {
	readonly id: string;
	readonly target: RewriteTarget;
	readonly implementation: string;
}

/** Replace exactly the discovered method body if it has not changed. */
export function applyCandidate(source: string, candidate: RewriteCandidate): string {
	const { target } = candidate;
	const current = source.slice(target.bodyStart, target.bodyEnd);
	check(digest(current) === target.bodyDigest, `rewrite target changed after discovery: ${target.id}`);
	const replacement = formatImplementation(candidate.implementation, target.indentation, source);
	return `${source.slice(0, target.bodyStart)}${replacement}${source.slice(target.bodyEnd)}`;
}

/** Snapshot of one guarded body replacement; enough to revert it exactly. */
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

/** Apply a candidate and record the snapshot that reverts it exactly. Whether
 * a candidate deserves to be committed is the consumer's call — any gating
 * (approval, review, policy) happens before this function is reached. */
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

/** Restore the snapshot's previous body; refuses to overwrite later edits. */
export function revertRewrite(source: string, snapshot: RewriteSnapshot): string {
	const endOffset = snapshot.startOffset + snapshot.updated.length;
	check(source.slice(snapshot.startOffset, endOffset) === snapshot.updated, "rewritten method changed before revert");
	return `${source.slice(0, snapshot.startOffset)}${snapshot.previous}${source.slice(endOffset)}`;
}

function formatImplementation(implementation: string, methodIndent: string, source: string): string {
	// Match the method's own indentation style rather than the whole file's,
	// so a tab-indented method in a mostly-spaces file still gets tabs.
	const indentUnit = methodIndent.includes("\t") ? "\t" : source.includes("\t") ? "\t" : "  ";
	const bodyIndent = `${methodIndent}${indentUnit}`;
	const lines = implementation.split("\n");
	const minimumIndent = Math.min(
		...lines.filter((line) => line.trim()).map((line) => /^\s*/.exec(line)?.[0].length ?? 0),
	);
	const normalized = lines.map((line) => `${bodyIndent}${line.slice(Number.isFinite(minimumIndent) ? minimumIndent : 0)}`);
	return `\n${normalized.join("\n")}\n${methodIndent}`;
}
