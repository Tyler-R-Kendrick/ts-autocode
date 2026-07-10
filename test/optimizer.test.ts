import { describe, expect, it } from "vitest";

import {
	createBuiltInOptoEngine,
	parseRewriteProgram,
	predictLabel,
	replayTrainingRun,
	runBuiltInOptoTrainingRun,
} from "../src/index.js";
import { heldOutTrajectories, makeDualRegionRequest, makeOptimizeRequest } from "./fixtures.js";

describe("createBuiltInOptoEngine", () => {
	it("derives keyword rules from mislabeled trajectories and renders a program", async () => {
		const request = makeOptimizeRequest();
		const candidate = await createBuiltInOptoEngine().optimize(request);

		expect(candidate.edits).toHaveLength(1);
		const replacement = candidate.edits[0]?.replacement ?? "";
		expect(replacement).toContain("// ts-autocode:opto-rules v1");
		expect(replacement).toContain('return "billing-support";');
		expect(replacement.trim().endsWith('return "general-support";')).toBe(true);

		const program = parseRewriteProgram(replacement);
		expect(program.parseErrors).toEqual([]);
		expect(predictLabel(program, "billing invoice refund")).toBe("billing-support");
		expect(predictLabel(program, "unrelated question")).toBe("general-support");
	});

	it("emits one edit per region on a joint request", async () => {
		const request = makeDualRegionRequest();
		const candidate = await createBuiltInOptoEngine().optimize(request);

		expect(candidate.edits).toHaveLength(2);
		expect(candidate.edits.map((edit) => edit.regionId).sort()).toEqual(["classify-body", "fallback-body"]);
		for (const edit of candidate.edits) {
			const region = request.generatedRegions.find((r) => r.regionId === edit.regionId);
			expect(edit.startOffset).toBe(region?.startOffset);
			expect(edit.endOffset).toBe(region?.endOffset);
		}
	});

	it("records provenance binding the candidate to its evidence", async () => {
		const request = makeOptimizeRequest();
		const candidate = await createBuiltInOptoEngine().optimize(request);

		expect(candidate.provenance.rubricRef).toBe(request.rubric.id);
		expect(candidate.provenance.contractRef).toBe(request.contract.ref);
		expect(candidate.provenance.trajectoryHashes).toHaveLength(request.trajectories.length);
		for (const hash of candidate.provenance.trajectoryHashes) {
			expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
		}
	});
});

describe("runBuiltInOptoTrainingRun", () => {
	it("produces a ready-for-gate candidate when held-out eval improves on baseline", async () => {
		const run = await runBuiltInOptoTrainingRun({
			request: makeOptimizeRequest(),
			heldOutTrajectories: heldOutTrajectories(),
		});

		expect(run.outcome).toBe("ready-for-gate");
		expect(run.screening?.passFlags).toEqual({ conformance: true, heldOutEval: true });
		expect(run.evaluation?.baselineScore).toBe(0);
		expect(run.evaluation?.candidateScore).toBe(1);
		expect(run.rejectionReasons).toEqual([]);
	});

	it("rejects when there is no held-out data, with a terminal Rejected event", async () => {
		const run = await runBuiltInOptoTrainingRun({
			request: makeOptimizeRequest(),
			heldOutTrajectories: [],
		});

		expect(run.outcome).toBe("rejected");
		expect(run.rejectionReasons).toContain("held-out.required");
		expect(run.events.at(-1)?.type).toBe("training.Rejected");
		expect(replayTrainingRun(run.events).status).toBe("rejected");
	});

	it("emits RunStarted + Rejected when the engine's patch is invalid", async () => {
		const run = await runBuiltInOptoTrainingRun({
			request: makeOptimizeRequest(),
			heldOutTrajectories: heldOutTrajectories(),
			engine: {
				engineId: "broken",
				optimize() {
					throw new Error("no candidate");
				},
			},
		});

		expect(run.outcome).toBe("rejected");
		expect(run.events.map((event) => event.type)).toEqual(["training.RunStarted", "training.Rejected"]);
		expect(replayTrainingRun(run.events).status).toBe("rejected");
	});

	it("rejects a candidate whose fallback violates the contract", async () => {
		const request = makeOptimizeRequest();
		const run = await runBuiltInOptoTrainingRun({
			request: {
				...request,
				contract: {
					...request.contract,
					invariants: {
						...request.contract.invariants,
						requiredFallback: "identity-support",
					},
				},
			},
			heldOutTrajectories: heldOutTrajectories(),
			// The engine renders whatever fallback the contract demands, so force
			// the mismatch by using an engine built for a different contract.
			engine: {
				engineId: "fixture-engine",
				optimize: (req) =>
					createBuiltInOptoEngine().optimize({
						...req,
						contract: {
							...req.contract,
							invariants: { ...req.contract.invariants, requiredFallback: "general-support" },
						},
					}),
			},
		});

		expect(run.outcome).toBe("rejected");
		expect(run.rejectionReasons).toContain("contract.required-fallback:identity-support");
	});

	it("emits a replayable event log for the run", async () => {
		const run = await runBuiltInOptoTrainingRun({
			request: makeOptimizeRequest({ requestId: "run-events-1" }),
			heldOutTrajectories: heldOutTrajectories(),
		});

		expect(run.events.map((event) => event.type)).toEqual([
			"training.RunStarted",
			"training.CandidateProposed",
			"training.CandidateEvaluated",
		]);
		expect(run.replayDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

		const projection = replayTrainingRun(run.events);
		expect(projection.runId).toBe("run-events-1");
		expect(projection.status).toBe("running");
		expect(projection.candidateIds).toEqual([run.candidate?.id]);
	});

	it("is deterministic: identical requests produce identical replay digests", async () => {
		const first = await runBuiltInOptoTrainingRun({
			request: makeOptimizeRequest(),
			heldOutTrajectories: heldOutTrajectories(),
		});
		const second = await runBuiltInOptoTrainingRun({
			request: makeOptimizeRequest(),
			heldOutTrajectories: heldOutTrajectories(),
		});

		expect(first.replayDigest).toBe(second.replayDigest);
		expect(first.candidate?.id).toBe(second.candidate?.id);
	});
});
