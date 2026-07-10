import { describe, expect, it } from "vitest";

import {
	createBuiltInOptoEngine,
	optimizeCandidate,
	runEngineConformance,
	validateOptimizeRequest,
	validateTrajectory,
} from "../src/index.js";
import { createOutOfRegionEngine, makeOptimizeRequest, makeTrajectory } from "./fixtures.js";

describe("validateTrajectory", () => {
	it("accepts a well-formed trajectory", () => {
		const trajectory = makeTrajectory({
			id: "t-1",
			input: "billing invoice",
			baselineLabel: "general-support",
			expectedLabel: "billing-support",
		});

		expect(validateTrajectory(trajectory).ok).toBe(true);
	});

	it("rejects sensitive payloads that are neither tokenized nor encrypted", () => {
		const trajectory = {
			...makeTrajectory({
				id: "t-pii",
				input: "billing invoice",
				baselineLabel: "general-support",
				expectedLabel: "billing-support",
			}),
			payloads: {
				email: { classification: "pii", redaction: "none", value: "user@example.com" },
			},
		};

		const result = validateTrajectory(trajectory);
		expect(result.ok).toBe(false);
		expect(result.errors).toContain("sensitive payload email must be tokenized or encrypted");
	});

	it("accepts encrypted sensitive payloads scoped to the run", () => {
		const base = makeTrajectory({
			id: "t-enc",
			input: "billing invoice",
			baselineLabel: "general-support",
			expectedLabel: "billing-support",
		});
		const trajectory = {
			...base,
			payloads: {
				email: {
					classification: "pii",
					redaction: "encrypted",
					encryptedRef: `run://${base.run.id}/email`,
				},
			},
		};

		expect(validateTrajectory(trajectory).ok).toBe(true);
	});

	it("rejects an invalid traceparent and dangling span parents", () => {
		const base = makeTrajectory({
			id: "t-bad",
			input: "billing invoice",
			baselineLabel: "general-support",
			expectedLabel: "billing-support",
		});
		const result = validateTrajectory({
			...base,
			traceparent: "not-a-traceparent",
			spans: [{ ...base.spans[0], parentId: "missing-span" }],
		});

		expect(result.ok).toBe(false);
		expect(result.errors).toContain("trajectory.traceparent must be W3C traceparent");
		expect(result.errors).toContain("spans.0.parentId must reference another span");
	});
});

describe("validateOptimizeRequest", () => {
	it("accepts a well-formed request", () => {
		expect(validateOptimizeRequest(makeOptimizeRequest()).ok).toBe(true);
	});

	it("requires the contract to bind to the requested region", () => {
		const request = makeOptimizeRequest();
		const result = validateOptimizeRequest({
			...request,
			contract: { ...request.contract, allowedRegionId: "some-other-region" },
		});

		expect(result.ok).toBe(false);
		expect(result.errors).toContain("request.contract.allowedRegionId must match request.generatedRegion.regionId");
	});
});

describe("optimizeCandidate", () => {
	it("rejects a candidate whose edits leave the generated region", () => {
		const result = optimizeCandidate(createOutOfRegionEngine(), makeOptimizeRequest());

		expect(result.ok).toBe(false);
		expect(result.candidate).toBeNull();
		expect(result.errors.some((error) => error.includes("must stay within generated region"))).toBe(true);
	});

	it("reports an engine that throws instead of propagating", () => {
		const result = optimizeCandidate(
			{
				engineId: "boom",
				optimize() {
					throw new Error("exploded");
				},
			},
			makeOptimizeRequest(),
		);

		expect(result.ok).toBe(false);
		expect(result.errors[0]).toContain("engine threw during optimize: exploded");
	});
});

describe("runEngineConformance", () => {
	it("certifies the built-in engine as deterministic and region-bound", () => {
		const report = runEngineConformance(createBuiltInOptoEngine(), makeOptimizeRequest());

		expect(report.errors).toEqual([]);
		expect(report.ok).toBe(true);
	});

	it("fails an engine that edits outside the region", () => {
		const report = runEngineConformance(createOutOfRegionEngine(), makeOptimizeRequest());

		expect(report.ok).toBe(false);
	});
});
