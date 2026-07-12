import { readFile, writeFile } from "node:fs/promises";

import {
	commitRewrite,
	configureRewrite,
	restoreImplementation,
	revertRewrite,
	swapImplementation,
} from "ts-autocode-rewrite";
import { captureTrainable, trainingMarker, type PromotionApplier } from "ts-autocode-training";

/** The sibling packages never import each other; this package owns the wiring.
 * Every method the rewrite engine weaves under the training marker routes
 * through training's runtime capture, and `proceed` resolves the live
 * (possibly hot-swapped) implementation so captures reflect what ran.
 * Configuring twice is harmless. */
export function configureRewriteCapture(): void {
	configureRewrite({
		marker: trainingMarker,
		intercept: ({ id, methodName, thisValue, args, proceed }) =>
			captureTrainable(
				id,
				methodName,
				thisValue,
				function (this: unknown, ...next: unknown[]) { return proceed(...next); },
				[...args],
			),
	});
}

/** Promotion through ts-autocode-rewrite: writes the digest-guarded source
 * rewrite, hot-swaps async targets live, and returns the exact undo. The
 * rewrite package is training-agnostic, so the promotion gate is enforced
 * here — where training's decision meets the guarded rewrite. Only async
 * targets swap: the executor returns a promise, so swapping a synchronous
 * method would change its calling convention. */
export const rewritePromotion: PromotionApplier = async (candidate, decision, executor) => {
	if (!decision.promote || decision.candidateId !== candidate.id) {
		throw new Error(`candidate has not passed the promotion gate: ${candidate.id}`);
	}
	const artifactRef = candidate.target.artifactRef;
	const source = await readFile(artifactRef, "utf8");
	const committed = commitRewrite(source, candidate);
	await writeFile(artifactRef, committed.source, "utf8");
	if (candidate.target.async && executor) {
		// Normal function so the call receiver is captured and forwarded to
		// executors that can bind it (the sandbox executor ignores it).
		swapImplementation(candidate.trainableId, function (this: unknown, ...args: unknown[]) {
			return executor(candidate.target, candidate.implementation, args, { receiver: this });
		});
	}
	return {
		rollback: async () => {
			const current = await readFile(artifactRef, "utf8");
			await writeFile(artifactRef, revertRewrite(current, committed.snapshot), "utf8");
			restoreImplementation(candidate.trainableId);
		},
	};
};
