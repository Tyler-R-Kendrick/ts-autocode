import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
	CANDIDATE_PATCH_SCHEMA,
	type CandidatePatch,
	PromotionError,
	type SignedProvenance,
	canonicalJson,
	createChampionChallengerPromotion,
	createEd25519ProvenanceVerifier,
	digest,
	promoteCandidate,
	revertPromotion,
} from "../src/index.js";
import {
	FIXTURE_TS,
	classifierRegion,
	classifierSource,
	completeProvenance,
	dualRegionSource,
	fallbackRegion,
} from "./fixtures.js";

function billingCandidate(region = classifierRegion()): CandidatePatch {
	return {
		schema: CANDIDATE_PATCH_SCHEMA,
		id: "candidate-billing-1",
		engineId: "ts-autocode.training-engine/built-in-opto@0.1.0",
		regions: [region],
		edits: [
			{
				regionId: region.regionId,
				startOffset: region.startOffset,
				endOffset: region.endOffset,
				replacement: '  return "billing-support";',
			},
		],
		provenance: {
			trajectoryHashes: [],
			rubricRef: "rubric://classify@1.0.0",
			contractRef: "contract://classify@1.0.0",
		},
	};
}

function dualRegionCandidate(): CandidatePatch {
	const source = dualRegionSource();
	const regions = [classifierRegion(source), fallbackRegion(source)];
	return {
		schema: CANDIDATE_PATCH_SCHEMA,
		id: "candidate-dual-1",
		engineId: "ts-autocode.training-engine/built-in-opto@0.1.0",
		regions,
		edits: regions.map((region) => ({
			regionId: region.regionId,
			startOffset: region.startOffset,
			endOffset: region.endOffset,
			replacement: '  return "billing-support";',
		})),
		provenance: {
			trajectoryHashes: [],
			rubricRef: "rubric://classify@1.0.0",
			contractRef: "contract://classify@1.0.0",
		},
	};
}

const greenGate = { effect: "certify", certified: true, reason: "three-lens green" } as const;

describe("shadowTraffic", () => {
	it("runs both arms but always serves the champion", () => {
		const promotion = createChampionChallengerPromotion({ now: () => FIXTURE_TS });
		const result = promotion.shadowTraffic({
			champion: (input: string) => `champion:${input}`,
			challenger: (input: string) => `challenger:${input}`,
			requests: ["a", "b"],
		});

		expect(result.mode).toBe("shadow");
		expect(result.samples).toHaveLength(2);
		for (const sample of result.samples) {
			expect(sample.servedResponse).toBe(sample.championResponse);
			expect(sample.challengerServed).toBe(false);
			expect(sample.challengerResponse).toContain("challenger:");
		}
	});
});

describe("promoteCandidate", () => {
	it("auto-applies in low-risk non-prod environments and records a revert snapshot", () => {
		const source = classifierSource();
		const result = promoteCandidate({
			source,
			regions: [classifierRegion(source)],
			candidate: billingCandidate(),
			gate: greenGate,
			provenance: completeProvenance(),
			environment: "preview",
			riskClass: "low",
			ts: FIXTURE_TS,
		});

		expect(result.effect).toBe("auto-applied");
		expect(result.source).toContain('return "billing-support";');
		expect(result.source).toContain("handWrittenGuard = true");
		expect(result.events.map((event) => event.type)).toEqual(["training.Promoted", "impl.Promoted"]);
		expect(result.events[1]?.data["previousRegionSource"]).toBe('  return "identity-support";\n');
	});

	it("auto-applies a joint multi-region candidate with one snapshot per region", () => {
		const source = dualRegionSource();
		const result = promoteCandidate({
			source,
			regions: [classifierRegion(source), fallbackRegion(source)],
			candidate: dualRegionCandidate(),
			gate: greenGate,
			provenance: completeProvenance(),
			environment: "preview",
			riskClass: "low",
			ts: FIXTURE_TS,
		});

		expect(result.effect).toBe("auto-applied");
		expect((result.source.match(/return "billing-support";/g) ?? []).length).toBe(2);
		const implEvents = result.events.filter((event) => event.type === "impl.Promoted");
		expect(implEvents.map((event) => event.regionId).sort()).toEqual(["classify-body", "fallback-body"]);
	});

	it("returns a PR delta instead of touching source in prod", () => {
		const source = classifierSource();
		const result = promoteCandidate({
			source,
			regions: [classifierRegion(source)],
			candidate: billingCandidate(),
			gate: greenGate,
			provenance: completeProvenance(),
			environment: "prod",
			riskClass: "low",
			ts: FIXTURE_TS,
		});

		expect(result.effect).toBe("pr-delta");
		expect(result.source).toBe(source);
		expect(result.delta?.kind).toBe("source-pr-delta");
		expect(result.delta?.candidateId).toBe("candidate-billing-1");
		expect(result.delta?.regionIds).toEqual(["classify-body"]);
		expect(result.events.map((event) => event.type)).toEqual(["training.Promoted"]);
	});

	it("returns a PR delta for high-risk promotions in any environment", () => {
		const source = classifierSource();
		const result = promoteCandidate({
			source,
			regions: [classifierRegion(source)],
			candidate: billingCandidate(),
			gate: greenGate,
			provenance: completeProvenance(),
			environment: "preview",
			riskClass: "high",
			ts: FIXTURE_TS,
		});

		expect(result.effect).toBe("pr-delta");
	});

	it("is idempotent: promoting an already-applied candidate is a no-op", () => {
		const source = classifierSource();
		const first = promoteCandidate({
			source,
			regions: [classifierRegion(source)],
			candidate: billingCandidate(),
			gate: greenGate,
			provenance: completeProvenance(),
			environment: "preview",
			riskClass: "low",
			ts: FIXTURE_TS,
		});
		const second = promoteCandidate({
			source: first.source,
			regions: [classifierRegion(source)],
			candidate: billingCandidate(),
			gate: greenGate,
			provenance: completeProvenance(),
			environment: "preview",
			riskClass: "low",
			ts: FIXTURE_TS,
		});

		expect(second.effect).toBe("already-applied");
		expect(second.source).toBe(first.source);
		expect(second.events).toEqual([]);
	});

	it("refuses partial-region edits at promotion time", () => {
		const source = classifierSource();
		const region = classifierRegion(source);
		const partial = {
			...billingCandidate(region),
			edits: [
				{
					regionId: region.regionId,
					startOffset: region.startOffset,
					endOffset: region.startOffset + 4,
					replacement: "  //",
				},
			],
		};

		expect(() =>
			promoteCandidate({
				source,
				regions: [region],
				candidate: partial,
				gate: greenGate,
				provenance: completeProvenance(),
				environment: "preview",
				ts: FIXTURE_TS,
			}),
		).toThrowError(/promotion.full_region_edit_required/);
	});

	it("refuses when the gate is not green", () => {
		expect(() =>
			promoteCandidate({
				source: classifierSource(),
				regions: [classifierRegion()],
				candidate: billingCandidate(),
				gate: { effect: "refuse", certified: false },
				provenance: completeProvenance(),
				environment: "preview",
				ts: FIXTURE_TS,
			}),
		).toThrowError(/promotion.gate_not_green/);
	});

	it("refuses unsigned provenance", () => {
		const provenance = completeProvenance();
		expect(() =>
			promoteCandidate({
				source: classifierSource(),
				regions: [classifierRegion()],
				candidate: billingCandidate(),
				gate: greenGate,
				provenance: {
					...provenance,
					signature: { ...provenance.signature, value: "" },
				},
				environment: "preview",
				ts: FIXTURE_TS,
			}),
		).toThrowError(PromotionError);
	});

	it("refuses when the region boundary drifted from the promotion request", () => {
		const source = classifierSource();
		const region = classifierRegion(source);
		expect(() =>
			promoteCandidate({
				source,
				regions: [{ ...region, endOffset: region.endOffset + 2 }],
				candidate: billingCandidate(),
				gate: greenGate,
				provenance: completeProvenance(),
				environment: "preview",
				ts: FIXTURE_TS,
			}),
		).toThrowError(/promotion.region_boundary_mismatch/);
	});
});

describe("Ed25519 provenance verification", () => {
	function signedProvenance(): { provenance: SignedProvenance; publicKeyPem: string } {
		const { publicKey, privateKey } = generateKeyPairSync("ed25519");
		const base = completeProvenance();
		const payload = base.payload;
		const payloadBytes = Buffer.from(canonicalJson(payload), "utf8");
		const signature = cryptoSign(null, payloadBytes, privateKey).toString("base64");
		return {
			provenance: {
				...base,
				signature: {
					alg: "Ed25519",
					payloadDigest: digest(payload),
					value: signature,
				},
			},
			publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
		};
	}

	it("accepts provenance signed by the trusted key", () => {
		const { provenance, publicKeyPem } = signedProvenance();
		const result = promoteCandidate({
			source: classifierSource(),
			regions: [classifierRegion()],
			candidate: billingCandidate(),
			gate: greenGate,
			provenance,
			environment: "preview",
			riskClass: "low",
			ts: FIXTURE_TS,
			verifySignature: createEd25519ProvenanceVerifier(publicKeyPem),
		});

		expect(result.effect).toBe("auto-applied");
	});

	it("refuses fabricated provenance when a verifier is wired in", () => {
		const { publicKeyPem } = signedProvenance();
		expect(() =>
			promoteCandidate({
				source: classifierSource(),
				regions: [classifierRegion()],
				candidate: billingCandidate(),
				gate: greenGate,
				provenance: completeProvenance(),
				environment: "preview",
				ts: FIXTURE_TS,
				verifySignature: createEd25519ProvenanceVerifier(publicKeyPem),
			}),
		).toThrowError(/promotion.provenance_signature_invalid/);
	});

	it("refuses a signature over a tampered payload", () => {
		const { provenance, publicKeyPem } = signedProvenance();
		// Recompute the digest for the tampered payload so the digest guard
		// passes and the Ed25519 verification itself does the rejecting.
		const tamperedPayload = { ...provenance.payload, seed: "tampered-seed" };
		const tampered = {
			...provenance,
			payload: tamperedPayload,
			signature: { ...provenance.signature, payloadDigest: digest(tamperedPayload) },
		};
		expect(() =>
			promoteCandidate({
				source: classifierSource(),
				regions: [classifierRegion()],
				candidate: billingCandidate(),
				gate: greenGate,
				provenance: tampered,
				environment: "preview",
				ts: FIXTURE_TS,
				verifySignature: createEd25519ProvenanceVerifier(publicKeyPem),
			}),
		).toThrowError(/promotion.provenance_signature_invalid/);
	});
});

describe("revertPromotion", () => {
	it("restores the previous region source from the promotion events", () => {
		const source = classifierSource();
		const promoted = promoteCandidate({
			source,
			regions: [classifierRegion(source)],
			candidate: billingCandidate(),
			gate: greenGate,
			provenance: completeProvenance(),
			environment: "preview",
			riskClass: "low",
			ts: FIXTURE_TS,
		});

		const reverted = revertPromotion({
			source: promoted.source,
			events: promoted.events,
			candidateId: "candidate-billing-1",
		});

		expect(reverted.effect).toBe("reverted");
		expect(reverted.source).toBe(source);
	});

	it("restores every region of a multi-region promotion", () => {
		const source = dualRegionSource();
		const promoted = promoteCandidate({
			source,
			regions: [classifierRegion(source), fallbackRegion(source)],
			candidate: dualRegionCandidate(),
			gate: greenGate,
			provenance: completeProvenance(),
			environment: "preview",
			riskClass: "low",
			ts: FIXTURE_TS,
		});

		const reverted = revertPromotion({
			source: promoted.source,
			events: promoted.events,
			candidateId: "candidate-dual-1",
		});

		expect(reverted.source).toBe(source);
	});

	it("refuses to revert when no snapshot exists for the candidate", () => {
		expect(() =>
			revertPromotion({ source: classifierSource(), events: [], candidateId: "candidate-billing-1" }),
		).toThrowError(/promotion.revert_snapshot_missing/);
	});

	it("refuses to revert when the promoted region has since changed", () => {
		const source = classifierSource();
		const promoted = promoteCandidate({
			source,
			regions: [classifierRegion(source)],
			candidate: billingCandidate(),
			gate: greenGate,
			provenance: completeProvenance(),
			environment: "preview",
			riskClass: "low",
			ts: FIXTURE_TS,
		});

		const tampered = promoted.source.replace('"billing-support"', '"tampered"');
		expect(() =>
			revertPromotion({ source: tampered, events: promoted.events, candidateId: "candidate-billing-1" }),
		).toThrowError(/promotion.revert_current_region_mismatch/);
	});
});
