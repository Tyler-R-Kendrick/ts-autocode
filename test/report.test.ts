import { describe, expect, it } from "vitest";

import { renderOptimizeReport, runBuiltInOptoTrainingRun } from "../src/index.js";
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
		expect(report).toContain("reward: 0.9");
		expect(report).toContain("# Request");
		expect(report).toContain('"schema": "ts-autocode.training.candidate-patch/v1"');
	});

	it("notes missing region sources instead of omitting the section", () => {
		const report = renderOptimizeReport(makeOptimizeRequest());
		expect(report).toContain("(current region source not provided)");
	});

	it("carries prior-round screening and feedback into the report", async () => {
		const request = makeOptimizeRequest();
		const failed = await runBuiltInOptoTrainingRun({ request, heldOutTrajectories: [] });
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
