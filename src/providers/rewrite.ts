import { readFile, writeFile } from "node:fs/promises";

import {
	commitRewrite,
	configureRewrite,
	restoreImplementation,
	revertRewrite,
	swapImplementation,
} from "ts-autocode-rewrite";
import { captureTrainable, PromotionRejectedError, trainingMarker, type PromotionApplier } from "ts-autocode-training";

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

export const rewritePromotion: PromotionApplier = async (candidate, decision, executor) => {
	if (!decision.promote || decision.candidateId !== candidate.id) {
		throw new PromotionRejectedError(candidate.id, decision);
	}
	const artifactRef = candidate.target.artifactRef;
	const source = await readFile(artifactRef, "utf8");
	const committed = commitRewrite(source, candidate);
	await writeFile(artifactRef, committed.source, "utf8");
	if (candidate.target.async && executor) {
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
