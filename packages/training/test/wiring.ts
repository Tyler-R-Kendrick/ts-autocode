import { readFile, writeFile } from "node:fs/promises";

import { promoteCandidate, revertPromotion } from "ts-autocode-rewrite";

import { provideTrainingDefaults, type PromotionApplier } from "../src/index.js";

/** Wires a promotion applier into training's provider slot the same way the
 * main ts-autocode package does, using ts-autocode-rewrite for the guarded
 * body replacement. The sibling is a devDependency only: the runtime under
 * test never imports it and knows nothing beyond the `PromotionApplier`
 * contract. */
const promote: PromotionApplier = async (candidate, decision) => {
	const artifactRef = candidate.target.artifactRef;
	const source = await readFile(artifactRef, "utf8");
	const promoted = promoteCandidate({ source, candidate, decision });
	await writeFile(artifactRef, promoted.source, "utf8");
	return {
		rollback: async () => {
			const current = await readFile(artifactRef, "utf8");
			await writeFile(artifactRef, revertPromotion(current, promoted.snapshot), "utf8");
		},
	};
};

provideTrainingDefaults({ promote });
