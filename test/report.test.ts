import { describe, expect, it } from "vitest";

import { renderOptimizeReport, runTrainingRun } from "../src/index.js";
import { heldOutTrajectories, makeDualRegionRequest, makeOptimizeRequest } from "./fixtures.js";

describe("renderOptimizeReport", () => {
	it("renders instruction, code, trace, feedback, and the requested patch shape", () => {
		const request = makeDualRegionRequest();
		const report = renderOptimizeReport(request);

		expect(report).toContain("# Instruction");
		expect(report).toContain("Objective: promote billing label without breaking fallback");
		expect(report).toContain("Forbidden outputs: admin-support");
		expect(report).toContain("# Code");
		expect(report).toContain("## Region classify-body");
		expect(report).toContain("## Region fallback-body");
		expect(report).toContain('return "identity-support";');
		expect(report).toContain("# Trace");
		expect(report).toContain("## Trajectory train-billing-1");
		expect(report).toContain("[LLM] llm.classify");
		expect(report).toContain("score reward: 0.9");
		expect(report).toContain("model=stub-classifier tokens=20/5");
		expect(report).toContain("# Request");
		expect(report).toContain('"schema": "ts-autocode.training.candidate-patch/v1"');
	});

	it("notes missing region sources instead of omitting the section", () => {
		const report = renderOptimizeReport(makeOptimizeRequest());
		expect(report).toContain("(current region source not provided)");
	});

	it("terminates on cyclic span parent references instead of hanging", () => {
		const request = makeOptimizeRequest();
		const base = request.trajectories[0]!;
		const cyclic = {
			...base,
			spans: [
				{ ...base.spans[0]!, id: "cycle-a", parentId: "cycle-b" },
				{ ...base.spans[1]!, id: "cycle-b", parentId: "cycle-a" },
			],
		};
		const report = renderOptimizeReport({ ...request, trajectories: [cyclic] });
		expect(typeof report).toBe("string");
		expect(report).toContain("# Trace");
	});

	it("carries prior-round screening and feedback into the report", async () => {
		const request = makeOptimizeRequest();
		const failed = await runTrainingRun({ request, heldOutTrajectories: [] });
		const report = renderOptimizeReport(
			{ ...request, feedback: [{ kind: "text", text: "prefer billing routes" }] },
			{
				...(failed.candidate === null ? {} : { previousCandidate: failed.candidate }),
				...(failed.screening === null ? {} : { screening: failed.screening }),
			},
		);

		expect(report).toContain("- feedback(text): prefer billing routes");
		expect(report).toContain("Previous screening outcome: rejected");
		expect(report).toContain("- rejected: held-out.required");
	});
});
