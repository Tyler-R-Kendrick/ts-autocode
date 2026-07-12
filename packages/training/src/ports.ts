import type { CandidatePatch } from "./engine.js";
import type { PromotionDecision } from "./promotion.js";

/** Ports this package weaves and promotes through instead of importing sibling
 * packages. The main `ts-autocode` package wires ts-autocode-rewrite into them
 * through `provideTrainingDefaults` — exactly as it wires the Ax engine and
 * the harness `TrainingLoop` — and any structurally compatible implementation
 * works in their place. */

type AnyMethod = (this: unknown, ...args: unknown[]) => unknown;
type Owner = abstract new (...args: never[]) => unknown;

/** One woven call, delivered to the marker's configured interceptor. Structural
 * mirror of ts-autocode-rewrite's RewriteInvocation. */
export interface WeaveInvocation {
	readonly id: string;
	readonly marker: string;
	readonly methodName: string;
	readonly thisValue: unknown;
	readonly args: readonly unknown[];
	/** Runs the live implementation: the hot-swapped candidate when one is active,
	 * otherwise the original method. */
	readonly proceed: (...args: unknown[]) => unknown;
}

/** Hot-swappable method weaving: marker configuration, method annotation, call
 * dispatch, and live implementation swaps. */
export interface MethodWeaver {
	configure(config: {
		readonly marker: string;
		readonly intercept?: (invocation: WeaveInvocation) => unknown;
	}): void;
	annotate(owner: Owner, methodName: string, id: string, marker: string): void;
	dispatch(
		id: string,
		marker: string,
		methodName: string,
		original: AnyMethod,
		thisValue: unknown,
		args: readonly unknown[],
	): unknown;
	/** The prototype (or constructor, for statics) that declares `methodName`. */
	declaringContainer(owner: Owner, methodName: string): object | undefined;
	swap(id: string, implementation: AnyMethod): void;
	restore(id: string): void;
}

/** Snapshot of one guarded body replacement; enough to revert it exactly.
 * Structural mirror of ts-autocode-rewrite's PromotionSnapshot. */
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

/** Guarded source rewriting for gate-approved candidates. */
export interface SourcePromoter {
	promote(input: {
		readonly source: string;
		readonly candidate: CandidatePatch;
		readonly decision: PromotionDecision;
	}): PromotionResult;
	revert(source: string, snapshot: PromotionSnapshot): string;
}
