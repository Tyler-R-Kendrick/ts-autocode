import { digest } from "./canonical.js";

/** The discovered method-body span a candidate may replace. Structural subset of
 * ts-autocode-training's TrainableTarget so either package's targets apply. */
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
	readonly trainableId: string;
	readonly target: RewriteTarget;
	readonly implementation: string;
}

/** Replace exactly the discovered method body if it has not changed. */
export function applyCandidate(source: string, candidate: RewriteCandidate): string {
	const { target } = candidate;
	if (target.id !== candidate.trainableId) throw new Error("candidate target must match its trainable id");
	const current = source.slice(target.bodyStart, target.bodyEnd);
	if (digest(current) !== target.bodyDigest) {
		throw new Error(`trainable method changed after optimization started: ${target.id}`);
	}
	const replacement = formatImplementation(candidate.implementation, target.indentation, source);
	return `${source.slice(0, target.bodyStart)}${replacement}${source.slice(target.bodyEnd)}`;
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
