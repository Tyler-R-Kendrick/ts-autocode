import { describe, expect, it } from "vitest";

import {
	createBuiltInOptoEngine,
	optimizeCandidate,
	runEngineConformance,
	validateOptimizeRequest,
	validateTrajectory,
} from "../src/index.js";
import { createOutOfRegionEngine, makeDualRegionRequest, makeOptimizeRequest, makeTrajectory } from "./fixtures.js";

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

	it("accepts a rewardless trajectory carrying general feedback", () => {
		const base = makeTrajectory({
			id: "t-fb",
			input: "billing invoice",
			baselineLabel: "general-support",
			expectedLabel: "billing-support",
		});
		const { reward: _reward, ...withoutReward } = base;

		expect(validateTrajectory(withoutReward).ok).toBe(false);
		expect(
			validateTrajectory({
				...withoutReward,
				feedback: [{ kind: "error", message: "TypeError: label is undefined" }],
			}).ok,
		).toBe(true);
	});

	it("rejects malformed feedback items", () => {
		const base = makeTrajectory({
			id: "t-bad-fb",
			input: "billing invoice",
			baselineLabel: "general-support",
			expectedLabel: "billing-support",
		});
		const result = validateTrajectory({
			...base,
			feedback: [{ kind: "score", score: 1.5 }, { kind: "mystery" }],
		});

		expect(result.ok).toBe(false);
		expect(result.errors).toContain("trajectory.feedback.0.score must be between 0 and 1");
		expect(result.errors).toContain("trajectory.feedback.1.kind must be score, text, or error");
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

	it("rejects sensitive payloads that retain a raw value alongside redaction refs", () => {
		const base = makeTrajectory({
			id: "t-leak",
			input: "billing invoice",
			baselineLabel: "general-support",
			expectedLabel: "billing-support",
		});
		const result = validateTrajectory({
			...base,
			payloads: {
				email: {
					classification: "pii",
					redaction: "tokenized",
					tokenRef: "tok-1",
					value: "user@example.com",
				},
			},
		});

		expect(result.ok).toBe(false);
		expect(result.errors).toContain("sensitive payload email must not retain a raw value alongside tokenRef");
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

	it("accepts a joint multi-region request", () => {
		const result = validateOptimizeRequest(makeDualRegionRequest());
		expect(result.errors).toEqual([]);
		expect(result.ok).toBe(true);
	});

	it("requires the contract to bind to the requested regions", () => {
		const request = makeOptimizeRequest();
		const result = validateOptimizeRequest({
			...request,
			contract: { ...request.contract, allowedRegionIds: ["some-other-region"] },
		});

		expect(result.ok).toBe(false);
		expect(result.errors).toContain(
			"request.contract.allowedRegionIds must match request.generatedRegions region ids",
		);
	});

	it("rejects duplicate region ids and unknown regionSources keys", () => {
		const request = makeOptimizeRequest();
		const region = request.generatedRegions[0]!;
		const result = validateOptimizeRequest({
			...request,
			generatedRegions: [region, region],
			regionSources: { "not-a-region": "code" },
		});

		expect(result.ok).toBe(false);
		expect(result.errors).toContain("request.generatedRegions.1.regionId must be unique");
		expect(result.errors).toContain("request.regionSources.not-a-region must reference a requested region");
	});

	it("validates run-level feedback", () => {
		const request = makeOptimizeRequest();
		const result = validateOptimizeRequest({ ...request, feedback: [{ kind: "text", text: "" }] });

		expect(result.ok).toBe(false);
		expect(result.errors).toContain("request.feedback.0.text must be a non-empty string");
	});
});

describe("optimizeCandidate", () => {
	it("rejects a candidate whose edits leave the generated region", async () => {
		const result = await optimizeCandidate(createOutOfRegionEngine(), makeOptimizeRequest());

		expect(result.ok).toBe(false);
		expect(result.candidate).toBeNull();
		expect(result.errors.some((error) => error.includes("must stay within generated region"))).toBe(true);
	});

	it("reports an engine that throws instead of propagating", async () => {
		const result = await optimizeCandidate(
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

	it("supports async engines", async () => {
		const builtIn = createBuiltInOptoEngine();
		const asyncEngine = {
			engineId: "async-wrapper",
			optimize: async (request: Parameters<typeof builtIn.optimize>[0]) => builtIn.optimize(request),
		};
		const result = await optimizeCandidate(asyncEngine, makeOptimizeRequest());

		expect(result.errors).toEqual([]);
		expect(result.ok).toBe(true);
	});
});

describe("runEngineConformance", () => {
	it("certifies the built-in engine as deterministic and region-bound", async () => {
		const report = await runEngineConformance(createBuiltInOptoEngine(), makeOptimizeRequest());

		expect(report.errors).toEqual([]);
		expect(report.ok).toBe(true);
	});

	it("certifies the built-in engine on a joint multi-region request", async () => {
		const report = await runEngineConformance(createBuiltInOptoEngine(), makeDualRegionRequest());

		expect(report.errors).toEqual([]);
		expect(report.ok).toBe(true);
	});

	it("fails an engine that edits outside the region", async () => {
		const report = await runEngineConformance(createOutOfRegionEngine(), makeOptimizeRequest());

		expect(report.ok).toBe(false);
	});
});
