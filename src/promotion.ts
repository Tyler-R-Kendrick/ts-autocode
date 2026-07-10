import { DIGEST_PATTERN, digest, isNonEmptyString, isRecord } from "./canonical.js";
import { type CandidatePatch, validateCandidatePatch } from "./engine.js";
import {
	type GeneratedRegion,
	type RegionEdit,
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

export interface PromoteInput {
	readonly source: string;
	readonly region: GeneratedRegion;
	readonly candidate: CandidatePatch;
	readonly gate: CertifiedGate;
	readonly provenance: SignedProvenance;
	/** Deployment environment; prod always goes through a PR delta. */
	readonly environment?: string;
	/** Risk classification; "high" always goes through a PR delta. */
	readonly riskClass?: string;
	readonly ts?: string;
	readonly markerOptions?: RegionMarkerOptions;
}

export interface PromotionResult {
	readonly schema: typeof PROMOTION_SCHEMA;
	readonly effect: "auto-applied" | "pr-delta" | "already-applied" | "reverted";
	readonly source: string;
	readonly delta: {
		readonly kind: "source-pr-delta";
		readonly regionId: string;
		readonly candidateId: string;
		readonly edits: readonly RegionEdit[];
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
}: {
	now?: () => string;
	markerOptions?: RegionMarkerOptions;
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
 * Applies a gate-certified candidate to the source. Low-risk, non-prod
 * promotions auto-apply in place (with a revert snapshot in the events);
 * prod or high-risk promotions return a PR delta for human review instead of
 * touching the source.
 */
export function promoteCandidate({
	source,
	region,
	candidate,
	gate,
	provenance,
	environment,
	riskClass,
	ts = new Date().toISOString(),
	markerOptions,
}: PromoteInput): PromotionResult {
	assertCertifiedGate(gate);
	validateSignedProvenance(provenance);

	if (isCandidateAlreadyApplied(source, candidate, markerOptions)) {
		return { schema: PROMOTION_SCHEMA, effect: "already-applied", source, delta: null, events: [] };
	}

	const currentRegion = assertRegionMatchesSource(source, region, markerOptions);
	const patchValidation = validateCandidatePatch(candidate, currentRegion);
	if (!patchValidation.ok || patchValidation.value === null) {
		throw new PromotionError("promotion.candidate_patch_invalid", "$.candidate", patchValidation.errors.join("; "));
	}

	const edits = normalizeEdits(patchValidation.value.edits, source);
	const firstEdit = edits[0] as RegionEdit;
	const previousRegionSource = source.slice(currentRegion.startOffset, currentRegion.endOffset);
	if (environment === "prod" || environment === "production" || riskClass === "high") {
		return {
			schema: PROMOTION_SCHEMA,
			effect: "pr-delta",
			source,
			delta: {
				kind: "source-pr-delta",
				regionId: currentRegion.regionId,
				candidateId: candidate.id,
				edits,
				provenanceDigest: digest(provenance),
			},
			events: [promotionEvent("training.Promoted", candidate, currentRegion, ts, "pending-pr-delta")],
		};
	}

	const nextSource = applyRegionEdits(source, edits);
	const promotedRegionSource = firstEdit.replacement;
	return {
		schema: PROMOTION_SCHEMA,
		effect: "auto-applied",
		source: nextSource,
		delta: null,
		events: [
			promotionEvent("training.Promoted", candidate, currentRegion, ts, "auto-applied", {
				previousRegionSource,
				promotedRegionSource,
				startOffset: firstEdit.startOffset,
			}),
			promotionEvent("impl.Promoted", candidate, currentRegion, ts, "auto-applied", {
				previousRegionSource,
				promotedRegionSource,
				startOffset: firstEdit.startOffset,
			}),
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
 * Restores the region snapshot recorded by the matching `impl.Promoted`
 * event. Revert is log-driven: no snapshot in the log, no revert.
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

	const promoted = [...events]
		.reverse()
		.find((event) => event.type === "impl.Promoted" && event.candidateId === candidateId);
	const data = promoted?.data;
	const previousRegionSource = data?.["previousRegionSource"];
	const promotedRegionSource = data?.["promotedRegionSource"];
	const startOffset = data?.["startOffset"];
	if (
		!isNonEmptyString(previousRegionSource) ||
		!isNonEmptyString(promotedRegionSource) ||
		!Number.isInteger(startOffset)
	) {
		throw new PromotionError("promotion.revert_snapshot_missing", "$.events");
	}

	const endOffset = (startOffset as number) + promotedRegionSource.length;
	if (source.slice(startOffset as number, endOffset) !== promotedRegionSource) {
		throw new PromotionError("promotion.revert_current_region_mismatch", "$.source");
	}

	return {
		schema: PROMOTION_SCHEMA,
		effect: "reverted",
		source: `${source.slice(0, startOffset as number)}${previousRegionSource}${source.slice(endOffset)}`,
	};
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
		throw new PromotionError("promotion.region_boundary_mismatch", "$.region");
	}
	return currentRegion;
}

function isCandidateAlreadyApplied(
	source: string,
	candidate: CandidatePatch,
	markerOptions?: RegionMarkerOptions,
): boolean {
	try {
		const currentRegion = findGeneratedRegion(source, candidate?.region?.regionId, {
			...(candidate?.region?.artifactRef === undefined ? {} : { artifactRef: candidate.region.artifactRef }),
			...(markerOptions ?? {}),
		});
		const currentRegionSource = source.slice(currentRegion.startOffset, currentRegion.endOffset);
		const replacement = candidate?.edits?.[0]?.replacement;
		if (typeof replacement !== "string") {
			return false;
		}
		const normalizedReplacement =
			currentRegionSource.endsWith("\n") && !replacement.endsWith("\n") ? `${replacement}\n` : replacement;
		return currentRegionSource === normalizedReplacement;
	} catch {
		return false;
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

function normalizeEdits(edits: readonly RegionEdit[], source: string): RegionEdit[] {
	return edits.map((edit) => {
		const original = source.slice(edit.startOffset, edit.endOffset);
		const needsTrailingNewline = original.endsWith("\n") && !edit.replacement.endsWith("\n");
		return {
			startOffset: edit.startOffset,
			endOffset: edit.endOffset,
			replacement: needsTrailingNewline ? `${edit.replacement}\n` : edit.replacement,
		};
	});
}

function promotionEvent(
	type: string,
	candidate: CandidatePatch,
	region: GeneratedRegion,
	ts: string,
	effect: string,
	data: Record<string, unknown> = {},
): PromotionEvent {
	return {
		schema: PROMOTION_SCHEMA,
		id: `${candidate.id}:${type}`,
		type,
		ts,
		candidateId: candidate.id,
		regionId: region.regionId,
		effect,
		data,
	};
}

function valueAtPath(value: unknown, path: string): unknown {
	return path
		.replace(/^\$\./, "")
		.split(".")
		.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value);
}
