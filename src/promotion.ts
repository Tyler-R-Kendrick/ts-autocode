import { type KeyObject, createPublicKey, verify as cryptoVerify } from "node:crypto";

import { DIGEST_PATTERN, canonicalJson, digest, isNonEmptyString, isRecord } from "./canonical.js";
import { type CandidateEdit, type CandidatePatch, validateCandidatePatch } from "./engine.js";
import {
	type GeneratedRegion,
	type RegionMarkerOptions,
	applyRegionEdits,
	findGeneratedRegion,
} from "./region.js";

export const PROMOTION_SCHEMA = "ts-autocode.champion-challenger-promotion/v1";
export const PROVENANCE_PAYLOAD_SCHEMA = "ts-autocode.generation.provenance/v1";

export class PromotionError extends Error {
	readonly code: string;
	readonly path: string;

	constructor(code: string, path = "$", message = code) {
		super(`${code} at ${path}: ${message}`);
		this.name = "PromotionError";
		this.code = code;
		this.path = path;
	}
}

/** The certified gate verdict a promotion requires (e.g. from evaluatePromotionGate + certification). */
export interface CertifiedGate {
	readonly certified: boolean;
	readonly effect: "certify" | "approved" | string;
	readonly reason?: string;
}

/**
 * Signed provenance for the candidate: who generated it, from what frozen
 * prompt/model, with which conformance and eval reports. Promotion refuses
 * unsigned or incomplete provenance.
 */
export interface SignedProvenance {
	readonly kind: "generation-provenance";
	readonly signature: {
		readonly alg: "Ed25519";
		readonly payloadDigest: string;
		readonly value: string;
	};
	readonly payload: {
		readonly schema: typeof PROVENANCE_PAYLOAD_SCHEMA;
		readonly model: { readonly digest: string } & Record<string, unknown>;
		readonly prompt: { readonly frozenPromptDigest: string } & Record<string, unknown>;
		readonly artifact: { readonly digest: string } & Record<string, unknown>;
		readonly conformanceReportRef: { readonly digest: string } & Record<string, unknown>;
		readonly evalReportRefs: readonly Record<string, unknown>[];
	} & Record<string, unknown>;
}

export interface PromotionEvent {
	readonly schema: typeof PROMOTION_SCHEMA;
	readonly id: string;
	readonly type: string;
	readonly ts: string;
	readonly candidateId: string;
	readonly regionId: string;
	readonly effect: string;
	readonly data: Record<string, unknown>;
}

/**
 * Cryptographic check of the provenance signature. Shape validation alone
 * cannot prove the payload was signed by a trusted key — supply a verifier
 * (see createEd25519ProvenanceVerifier) to enforce that before promotion.
 */
export type ProvenanceVerifier = (provenance: SignedProvenance) => boolean;

export interface PromoteInput {
	readonly source: string;
	/** The current boundaries of every region the candidate rewrites. */
	readonly regions: readonly GeneratedRegion[];
	readonly candidate: CandidatePatch;
	readonly gate: CertifiedGate;
	readonly provenance: SignedProvenance;
	/** Deployment environment; prod always goes through a PR delta. */
	readonly environment?: string;
	/** Risk classification; "high" always goes through a PR delta. */
	readonly riskClass?: string;
	readonly ts?: string;
	readonly markerOptions?: RegionMarkerOptions;
	/** When provided, promotion refuses provenance whose signature does not verify. */
	readonly verifySignature?: ProvenanceVerifier;
}

export interface PromotionResult {
	readonly schema: typeof PROMOTION_SCHEMA;
	readonly effect: "auto-applied" | "pr-delta" | "already-applied" | "reverted";
	readonly source: string;
	readonly delta: {
		readonly kind: "source-pr-delta";
		readonly candidateId: string;
		readonly regionIds: readonly string[];
		readonly edits: readonly CandidateEdit[];
		readonly provenanceDigest: string;
	} | null;
	readonly events: readonly PromotionEvent[];
}

export interface ShadowSample<Req, Res> {
	readonly index: number;
	readonly request: Req;
	readonly championResponse: Res;
	readonly challengerResponse: Res;
	/** Shadow mode always serves the champion. */
	readonly servedResponse: Res;
	readonly challengerServed: false;
}

export interface ShadowTrafficResult<Req, Res> {
	readonly schema: typeof PROMOTION_SCHEMA;
	readonly mode: "shadow";
	readonly samples: readonly ShadowSample<Req, Res>[];
}

export interface ChampionChallengerPromotion {
	/** Runs the challenger in shadow: both arms execute, only the champion's answer is served. */
	shadowTraffic<Req, Res>(input: {
		champion: (request: Req) => Res;
		challenger: (request: Req) => Res;
		requests: readonly Req[];
	}): ShadowTrafficResult<Req, Res>;
	promote(input: Omit<PromoteInput, "ts">): PromotionResult;
	revert(input: RevertInput): RevertResult;
}

export function createChampionChallengerPromotion({
	now = () => new Date().toISOString(),
	markerOptions,
	verifySignature,
}: {
	now?: () => string;
	markerOptions?: RegionMarkerOptions;
	verifySignature?: ProvenanceVerifier;
} = {}): ChampionChallengerPromotion {
	return Object.freeze({
		shadowTraffic<Req, Res>({
			champion,
			challenger,
			requests,
		}: {
			champion: (request: Req) => Res;
			challenger: (request: Req) => Res;
			requests: readonly Req[];
		}): ShadowTrafficResult<Req, Res> {
			if (typeof champion !== "function" || typeof challenger !== "function") {
				throw new PromotionError("promotion.callable_required", "$.shadow");
			}
			if (!Array.isArray(requests)) {
				throw new PromotionError("promotion.requests_required", "$.requests");
			}

			const samples = requests.map((request, index) => {
				const championResponse = champion(request);
				const challengerResponse = challenger(request);
				return {
					index,
					request,
					championResponse,
					challengerResponse,
					servedResponse: championResponse,
					challengerServed: false as const,
				};
			});

			return { schema: PROMOTION_SCHEMA, mode: "shadow", samples };
		},

		promote(input: Omit<PromoteInput, "ts">): PromotionResult {
			return promoteCandidate({
				...(markerOptions === undefined ? {} : { markerOptions }),
				...(verifySignature === undefined ? {} : { verifySignature }),
				...input,
				ts: now(),
			});
		},

		revert(input: RevertInput): RevertResult {
			return revertPromotion(input);
		},
	});
}

/**
 * Applies a gate-certified candidate to the source across every region it
 * rewrites. Low-risk, non-prod promotions auto-apply in place (with one
 * revert snapshot per region in the events); prod or high-risk promotions
 * return a PR delta for human review instead of touching the source.
 */
export function promoteCandidate({
	source,
	regions,
	candidate,
	gate,
	provenance,
	environment,
	riskClass,
	ts = new Date().toISOString(),
	markerOptions,
	verifySignature,
}: PromoteInput): PromotionResult {
	assertCertifiedGate(gate);
	validateSignedProvenance(provenance);
	if (verifySignature && !verifySignature(provenance)) {
		throw new PromotionError("promotion.provenance_signature_invalid", "$.provenance.signature");
	}

	if (isCandidateAlreadyApplied(source, candidate, markerOptions)) {
		return { schema: PROMOTION_SCHEMA, effect: "already-applied", source, delta: null, events: [] };
	}

	if (!Array.isArray(regions) || regions.length === 0) {
		throw new PromotionError("promotion.regions_required", "$.regions");
	}
	const currentRegions = regions.map((region) => assertRegionMatchesSource(source, region, markerOptions));
	const patchValidation = validateCandidatePatch(candidate, currentRegions);
	if (!patchValidation.ok || patchValidation.value === null) {
		throw new PromotionError("promotion.candidate_patch_invalid", "$.candidate", patchValidation.errors.join("; "));
	}

	// Promotion requires exactly one full-region replacement per region so
	// the impl.Promoted snapshots (and therefore revert and idempotency)
	// always describe the entire region, never a partial span.
	assertFullRegionEdits(patchValidation.value.edits, currentRegions);

	const edits = normalizeEdits(patchValidation.value.edits, source);
	if (environment === "prod" || environment === "production" || riskClass === "high") {
		return {
			schema: PROMOTION_SCHEMA,
			effect: "pr-delta",
			source,
			delta: {
				kind: "source-pr-delta",
				candidateId: candidate.id,
				regionIds: currentRegions.map((region) => region.regionId),
				edits,
				provenanceDigest: digest(provenance),
			},
			events: [
				promotionEvent("training.Promoted", candidate, currentRegions.map((r) => r.regionId).join(","), ts, "pending-pr-delta"),
			],
		};
	}

	const nextSource = applyRegionEdits(source, edits);
	const regionById = new Map(currentRegions.map((region) => [region.regionId, region]));
	const implEvents = edits.map((edit) => {
		const region = regionById.get(edit.regionId) as GeneratedRegion;
		// Snapshot offsets must locate the region in the PROMOTED source:
		// edits at lower offsets shift everything after them by their length
		// delta, so add the cumulative delta of all earlier edits.
		const shift = edits
			.filter((other) => other.startOffset < edit.startOffset)
			.reduce((sum, other) => sum + (other.replacement.length - (other.endOffset - other.startOffset)), 0);
		return promotionEvent("impl.Promoted", candidate, edit.regionId, ts, "auto-applied", {
			previousRegionSource: source.slice(region.startOffset, region.endOffset),
			promotedRegionSource: edit.replacement,
			startOffset: edit.startOffset + shift,
		});
	});
	return {
		schema: PROMOTION_SCHEMA,
		effect: "auto-applied",
		source: nextSource,
		delta: null,
		events: [
			promotionEvent(
				"training.Promoted",
				candidate,
				currentRegions.map((r) => r.regionId).join(","),
				ts,
				"auto-applied",
			),
			...implEvents,
		],
	};
}

export interface RevertInput {
	readonly source: string;
	readonly events: readonly PromotionEvent[];
	readonly candidateId: string;
}

export interface RevertResult {
	readonly schema: typeof PROMOTION_SCHEMA;
	readonly effect: "reverted";
	readonly source: string;
}

/**
 * Restores every region snapshot recorded by the candidate's `impl.Promoted`
 * events (the latest per region). Revert is log-driven: no snapshot in the
 * log, no revert.
 */
export function revertPromotion({ source, events, candidateId }: RevertInput): RevertResult {
	if (!isNonEmptyString(source)) {
		throw new PromotionError("promotion.source_required", "$.source");
	}
	if (!isNonEmptyString(candidateId)) {
		throw new PromotionError("promotion.candidate_id_required", "$.candidateId");
	}
	if (!Array.isArray(events)) {
		throw new PromotionError("promotion.events_required", "$.events");
	}

	// Latest impl.Promoted snapshot per region for this candidate.
	const snapshots = new Map<string, { previous: string; promoted: string; startOffset: number }>();
	for (const event of events) {
		if (event.type !== "impl.Promoted" || event.candidateId !== candidateId) {
			continue;
		}
		const data = event.data;
		const previous = data?.["previousRegionSource"];
		const promoted = data?.["promotedRegionSource"];
		const startOffset = data?.["startOffset"];
		if (!isNonEmptyString(previous) || !isNonEmptyString(promoted) || !Number.isInteger(startOffset)) {
			continue;
		}
		snapshots.set(event.regionId, { previous, promoted, startOffset: startOffset as number });
	}
	if (snapshots.size === 0) {
		throw new PromotionError("promotion.revert_snapshot_missing", "$.events");
	}

	// Verify every snapshot against the current source, then restore
	// right-to-left so earlier offsets stay valid.
	const ordered = [...snapshots.values()].sort((left, right) => right.startOffset - left.startOffset);
	let nextSource = source;
	for (const snapshot of ordered) {
		const endOffset = snapshot.startOffset + snapshot.promoted.length;
		if (nextSource.slice(snapshot.startOffset, endOffset) !== snapshot.promoted) {
			throw new PromotionError("promotion.revert_current_region_mismatch", "$.source");
		}
		nextSource = `${nextSource.slice(0, snapshot.startOffset)}${snapshot.previous}${nextSource.slice(endOffset)}`;
	}

	return { schema: PROMOTION_SCHEMA, effect: "reverted", source: nextSource };
}

function assertRegionMatchesSource(
	source: string,
	region: GeneratedRegion,
	markerOptions?: RegionMarkerOptions,
): GeneratedRegion {
	const currentRegion = findGeneratedRegion(source, region?.regionId, {
		...(region?.artifactRef === undefined ? {} : { artifactRef: region.artifactRef }),
		...(markerOptions ?? {}),
	});
	if (currentRegion.startOffset !== region?.startOffset || currentRegion.endOffset !== region?.endOffset) {
		throw new PromotionError("promotion.region_boundary_mismatch", "$.regions");
	}
	return currentRegion;
}

function isCandidateAlreadyApplied(
	source: string,
	candidate: CandidatePatch,
	markerOptions?: RegionMarkerOptions,
): boolean {
	try {
		const edits = candidate?.edits;
		if (!Array.isArray(edits) || edits.length === 0) {
			return false;
		}
		return edits.every((edit) => {
			const bound = candidate.regions?.find((region) => region.regionId === edit.regionId);
			const currentRegion = findGeneratedRegion(source, edit.regionId, {
				...(bound?.artifactRef === undefined ? {} : { artifactRef: bound.artifactRef }),
				...(markerOptions ?? {}),
			});
			const currentRegionSource = source.slice(currentRegion.startOffset, currentRegion.endOffset);
			if (typeof edit.replacement !== "string") {
				return false;
			}
			const normalizedReplacement =
				currentRegionSource.endsWith("\n") && !edit.replacement.endsWith("\n")
					? `${edit.replacement}\n`
					: edit.replacement;
			return currentRegionSource === normalizedReplacement;
		});
	} catch {
		return false;
	}
}

function assertFullRegionEdits(edits: readonly CandidateEdit[], regions: readonly GeneratedRegion[]): void {
	const regionById = new Map(regions.map((region) => [region.regionId, region]));
	const seen = new Set<string>();
	for (const edit of edits) {
		const region = regionById.get(edit.regionId);
		if (!region || edit.startOffset !== region.startOffset || edit.endOffset !== region.endOffset) {
			throw new PromotionError("promotion.full_region_edit_required", "$.candidate.edits");
		}
		if (seen.has(edit.regionId)) {
			throw new PromotionError("promotion.full_region_edit_required", "$.candidate.edits");
		}
		seen.add(edit.regionId);
	}
}

function assertCertifiedGate(gate: CertifiedGate): void {
	if (!gate || gate.certified !== true || !["certify", "approved"].includes(gate.effect)) {
		throw new PromotionError("promotion.gate_not_green", "$.gate");
	}
}

export function validateSignedProvenance(provenance: unknown): asserts provenance is SignedProvenance {
	if (!isRecord(provenance)) {
		throw new PromotionError("promotion.provenance_required", "$.provenance");
	}
	if (provenance["kind"] !== "generation-provenance") {
		throw new PromotionError("promotion.provenance_kind", "$.provenance.kind");
	}
	const signature = provenance["signature"];
	if (!isRecord(signature) || signature["alg"] !== "Ed25519" || !signature["value"]) {
		throw new PromotionError("promotion.provenance_signature_required", "$.provenance.signature");
	}
	if (!DIGEST_PATTERN.test(String(signature["payloadDigest"] ?? ""))) {
		throw new PromotionError("promotion.provenance_signature_digest", "$.provenance.signature");
	}
	const payload = provenance["payload"];
	if (!isRecord(payload) || payload["schema"] !== PROVENANCE_PAYLOAD_SCHEMA) {
		throw new PromotionError("promotion.provenance_payload_schema", "$.provenance.payload");
	}
	for (const path of [
		"$.payload.model.digest",
		"$.payload.prompt.frozenPromptDigest",
		"$.payload.artifact.digest",
		"$.payload.conformanceReportRef.digest",
	]) {
		if (!DIGEST_PATTERN.test(String(valueAtPath(provenance, path) ?? ""))) {
			throw new PromotionError("promotion.provenance_digest", path);
		}
	}
	const evalReportRefs = payload["evalReportRefs"];
	if (!Array.isArray(evalReportRefs) || evalReportRefs.length === 0) {
		throw new PromotionError("promotion.provenance_eval_required", "$.provenance.payload.evalReportRefs");
	}
}

function normalizeEdits(edits: readonly CandidateEdit[], source: string): CandidateEdit[] {
	return edits.map((edit) => {
		const original = source.slice(edit.startOffset, edit.endOffset);
		const needsTrailingNewline = original.endsWith("\n") && !edit.replacement.endsWith("\n");
		return {
			regionId: edit.regionId,
			startOffset: edit.startOffset,
			endOffset: edit.endOffset,
			replacement: needsTrailingNewline ? `${edit.replacement}\n` : edit.replacement,
		};
	});
}

function promotionEvent(
	type: string,
	candidate: CandidatePatch,
	regionId: string,
	ts: string,
	effect: string,
	data: Record<string, unknown> = {},
): PromotionEvent {
	return {
		schema: PROMOTION_SCHEMA,
		id: `${candidate.id}:${type}:${regionId}`,
		type,
		ts,
		candidateId: candidate.id,
		regionId,
		effect,
		data,
	};
}

/**
 * Builds a ProvenanceVerifier that cryptographically checks the Ed25519
 * signature: the payload digest must match the canonical payload bytes, and
 * `signature.value` (base64) must verify over those bytes with the trusted
 * public key. Wire it into promoteCandidate/createChampionChallengerPromotion
 * so fabricated provenance cannot reach promotion.
 */
export function createEd25519ProvenanceVerifier(publicKey: KeyObject | string): ProvenanceVerifier {
	const key = typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey;
	return (provenance) => {
		try {
			if (provenance.signature.payloadDigest !== digest(provenance.payload)) {
				return false;
			}
			const payloadBytes = Buffer.from(canonicalJson(provenance.payload), "utf8");
			const signatureBytes = Buffer.from(provenance.signature.value, "base64");
			return cryptoVerify(null, payloadBytes, key, signatureBytes);
		} catch {
			return false;
		}
	};
}

function valueAtPath(value: unknown, path: string): unknown {
	return path
		.replace(/^\$\./, "")
		.split(".")
		.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value);
}
