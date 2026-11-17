import { readFile, writeFile } from "node:fs/promises";

import { commitRewrite, revertRewrite } from "ts-autocode-rewrite";

import { provideTrainingDefaults, type PromotionApplier } from "../src/index.js";

const promote: PromotionApplier = async (candidate, decision) => {
	if (!decision.promote || decision.candidateId !== candidate.id) {
		throw new Error(`candidate has not passed the promotion gate: ${candidate.id}`);
	}
	const artifactRef = candidate.target.artifactRef;
	const source = await readFile(artifactRef, "utf8");
	const committed = commitRewrite(source, candidate);
	await writeFile(artifactRef, committed.source, "utf8");
	return {
		rollback: async () => {
			const current = await readFile(artifactRef, "utf8");
			await writeFile(artifactRef, revertRewrite(current, committed.snapshot), "utf8");
		},
	};
};

provideTrainingDefaults({ promote });
