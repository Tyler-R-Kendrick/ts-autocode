import { describe, expect, it } from "vitest";

import {
	defineTrainable,
	evaluatePromotionGate,
	evaluateTrainable,
	findGeneratedRegion,
	promoteCandidate,
	revertPromotion,
	type CandidatePatch,
} from "../src/index.js";
import { generatedRegionSource } from "./fixtures.js";

const source = generatedRegionSource([{ id: "route", body: 'return "old";' }]);

describe("promotion", () => {
	it("gates with AgentV results and supports guarded revert", async () => {
		const token = defineTrainable("router.route");
		const artifactRef = "src/router.ts";
		const region = findGeneratedRegion(source, "route", { artifactRef });
		const candidate: CandidatePatch = {
			id: "candidate",
			trainableId: token.id,
			engineId: "test",
			edits: [{
				artifactRef,
				regionId: region.regionId,
				startOffset: region.startOffset,
				endOffset: region.endOffset,
				replacement: 'return "new";',
			}],
		};
		const evaluations = await evaluateTrainable(token, {
			tests: [{ id: "candidate", input: "route", assert: [{ type: "equals", value: "new" }] }],
			task: () => "new",
			outputDir: "test/output/agentv-promotion",
		});
		const decision = await evaluatePromotionGate({
			candidate,
			evaluations: evaluations.evaluations,
			conformance: true,
			policy: () => true,
		});

		expect(decision.promote).toBe(true);
		const promoted = promoteCandidate({
			artifacts: { [artifactRef]: source },
			candidate,
			regions: [region],
			decision,
		});
		expect(promoted.artifacts[artifactRef]).toContain('return "new";');
		const reverted = revertPromotion(promoted.artifacts, promoted.snapshot);
		expect(reverted[artifactRef]).toBe(source);
	});

	it("rejects AgentV results bound to another trainable", async () => {
		const candidateToken = defineTrainable("router.route");
		const otherToken = defineTrainable("router.other");
		const artifactRef = "src/router.ts";
		const region = findGeneratedRegion(source, "route", { artifactRef });
		const evaluated = await evaluateTrainable(otherToken, {
			tests: [{ id: "other", input: "route", assert: [{ type: "equals", value: "old" }] }],
			task: () => "old",
			outputDir: "test/output/agentv-promotion-mismatch",
		});
		const decision = await evaluatePromotionGate({
			candidate: {
				id: "candidate",
				trainableId: candidateToken.id,
				engineId: "test",
				edits: [{
					artifactRef,
					regionId: region.regionId,
					startOffset: region.startOffset,
					endOffset: region.endOffset,
					replacement: 'return "new";',
				}],
			},
			evaluations: evaluated.evaluations,
			conformance: true,
		});

		expect(decision.promote).toBe(false);
		expect(decision.failures).toContain("AgentV evaluations must match the candidate trainable id");
	});
});
