import { describe, expect, it } from "vitest";

import {
	CANDIDATE_PATCH_SCHEMA,
	type OptimizeRequest,
	type TrainingEngine,
	createBuiltInOptoEngine,
	runOptimizationLoop,
} from "../src/index.js";
import { heldOutTrajectories, makeOptimizeRequest } from "./fixtures.js";

describe("runOptimizationLoop", () => {
	it("stops after round one when the candidate is ready for the gate", async () => {
		const result = await runOptimizationLoop({
			request: makeOptimizeRequest(),
			engine: createBuiltInOptoEngine(),
			heldOutTrajectories: heldOutTrajectories(),
		});

		expect(result.outcome).toBe("ready-for-gate");
		expect(result.rounds).toHaveLength(1);
		expect(result.finalRun.candidate).not.toBeNull();
	});

	it("feeds rejection reasons back as error feedback so an adaptive engine converges", async () => {
		const seenFeedback: string[][] = [];
		// An engine that only produces a valid program once it has seen the
		// rejection feedback — the Trace step-loop shape.
		const adaptiveEngine: TrainingEngine = {
			engineId: "adaptive-fixture",
			optimize(request: OptimizeRequest) {
				seenFeedback.push((request.feedback ?? []).map((item) => (item.kind === "error" ? item.message : "")));
				const hasFeedback = (request.feedback ?? []).length > 0;
				if (!hasFeedback) {
					const region = request.generatedRegions[0]!;
					return {
						schema: CANDIDATE_PATCH_SCHEMA,
						id: "candidate-naive",
						engineId: "adaptive-fixture",
						regions: structuredClone(request.generatedRegions) as never,
						edits: [
							{
								regionId: region.regionId,
								startOffset: region.startOffset,
								endOffset: region.endOffset,
								replacement: 'return "admin-support";',
							},
						],
						provenance: { trajectoryHashes: [], rubricRef: request.rubric.id, contractRef: request.contract.ref },
					};
				}
				return createBuiltInOptoEngine().optimize(request);
			},
		};

		const result = await runOptimizationLoop({
			request: makeOptimizeRequest(),
			engine: adaptiveEngine,
			heldOutTrajectories: heldOutTrajectories(),
			maxRounds: 3,
		});

		expect(result.outcome).toBe("ready-for-gate");
		expect(result.rounds).toHaveLength(2);
		expect(result.rounds[0]?.run.outcome).toBe("rejected");
		expect(result.rounds[0]?.feedback.some((item) => item.kind === "error")).toBe(true);
		// Round two saw round one's rejection reasons.
		expect(seenFeedback[1]?.some((message) => message.includes("contract.forbidden-output"))).toBe(true);
	});

	it("stops early as stalled when a deterministic engine repeats itself", async () => {
		const result = await runOptimizationLoop({
			request: makeOptimizeRequest(),
			engine: createBuiltInOptoEngine(),
			heldOutTrajectories: [],
			maxRounds: 5,
		});

		expect(result.outcome).toBe("stalled");
		expect(result.rounds.length).toBeLessThanOrEqual(2);
	});

	it("exhausts maxRounds when every candidate id differs but keeps failing", async () => {
		let call = 0;
		const churningEngine: TrainingEngine = {
			engineId: "churning-fixture",
			optimize(request: OptimizeRequest) {
				call += 1;
				const region = request.generatedRegions[0]!;
				return {
					schema: CANDIDATE_PATCH_SCHEMA,
					id: `candidate-${call}`,
					engineId: "churning-fixture",
					regions: structuredClone(request.generatedRegions) as never,
					edits: [
						{
							regionId: region.regionId,
							startOffset: region.startOffset,
							endOffset: region.endOffset,
							replacement: 'return "admin-support";',
						},
					],
					provenance: { trajectoryHashes: [], rubricRef: request.rubric.id, contractRef: request.contract.ref },
				};
			},
		};

		const result = await runOptimizationLoop({
			request: makeOptimizeRequest(),
			engine: churningEngine,
			heldOutTrajectories: heldOutTrajectories(),
			maxRounds: 3,
		});

		expect(result.outcome).toBe("exhausted");
		expect(result.rounds).toHaveLength(3);
	});
});
