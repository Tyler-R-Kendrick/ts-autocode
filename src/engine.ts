import { canonicalJson, isNonEmptyString, isRecord } from "./canonical.js";
import type { GeneratedRegion } from "./region.js";
import {
	type Feedback,
	type Trajectory,
	type ValidationResult,
	validateFeedbackList,
	validateGeneratedRegionShape,
	validateTrajectory,
} from "./trajectory.js";

export const OPTIMIZE_REQUEST_SCHEMA = "ts-autocode.training.optimize-request/v1";
export const CANDIDATE_PATCH_SCHEMA = "ts-autocode.training.candidate-patch/v1";

/** Scoring configuration handed to the optimizer and the offline screen. */
export interface Rubric {
	readonly id: string;
	readonly objective: string;
	/** Candidate score minus baseline score must reach this on held-out data. */
	readonly minimumImprovement?: number;
	/** Candidate score alone must reach this on held-out data. */
	readonly heldOutThreshold?: number;
}

/**
 * The behavioral contract a rewrite must preserve. `invariants` is
 * engine-specific; the built-in optimizer understands allowed/forbidden
 * outputs and a required fallback.
 */
export interface OptimizeContract {
	readonly ref: string;
	readonly method: string;
	/** Must equal the requested generated-region ids as a set. */
	readonly allowedRegionIds: readonly string[];
	readonly invariants?: {
		readonly allowedOutputs?: readonly string[];
		readonly forbiddenOutputs?: readonly string[];
		readonly requiredFallback?: string;
	};
}

/**
 * Everything an engine gets: the regions to rewrite (jointly), evidence,
 * rubric, contract, and any run-level feedback from prior rounds.
 */
export interface OptimizeRequest {
	readonly schema: typeof OPTIMIZE_REQUEST_SCHEMA;
	readonly requestId: string;
	/** All trainable regions optimized together in this run. */
	readonly generatedRegions: readonly GeneratedRegion[];
	/** Optional regionId → current body text, so engines can read the code they rewrite. */
	readonly regionSources?: Readonly<Record<string, string>>;
	readonly trajectories: readonly Trajectory[];
	readonly rubric: Rubric;
	readonly contract: OptimizeContract;
	/** Run-level general feedback (e.g. a prior round's rejection reasons). */
	readonly feedback?: readonly Feedback[];
}

/** A single replacement bound to one of the requested regions. */
export interface CandidateEdit {
	readonly regionId: string;
	readonly startOffset: number;
	readonly endOffset: number;
	readonly replacement: string;
}

/**
 * The only thing an engine may return: edits strictly inside the requested
 * generated regions, with provenance for the audit trail.
 */
export interface CandidatePatch {
	readonly schema: typeof CANDIDATE_PATCH_SCHEMA;
	readonly id: string;
	readonly engineId: string;
	readonly regions: readonly GeneratedRegion[];
	readonly edits: readonly CandidateEdit[];
	readonly provenance: {
		readonly optimizer?: string;
		readonly trajectoryHashes: readonly string[];
		readonly rubricRef: string;
		readonly contractRef: string;
	} & Record<string, unknown>;
}

/**
 * The training-engine port. Any optimizer — a rule deriver, an LLM rewriter,
 * an RL trainer — plugs in behind this interface and stays swappable.
 * `optimize` may be synchronous or return a promise (LLM-backed engines).
 */
export interface TrainingEngine {
	readonly engineId: string;
	optimize(request: OptimizeRequest): CandidatePatch | Promise<CandidatePatch>;
}

export interface OptimizeOutcome {
	readonly ok: boolean;
	readonly errors: readonly string[];
	readonly candidate: CandidatePatch | null;
}

/**
 * Runs an engine against a validated request and validates the returned
 * patch. The engine receives a deep clone, so it cannot mutate the caller's
 * request, and an engine that throws or rejects is reported, not propagated.
 */
export async function optimizeCandidate(engine: TrainingEngine, request: OptimizeRequest): Promise<OptimizeOutcome> {
	const requestValidation = validateOptimizeRequest(request);
	if (!requestValidation.ok) {
		return { ok: false, errors: requestValidation.errors, candidate: null };
	}
	if (!engine || typeof engine.optimize !== "function") {
		return { ok: false, errors: ["engine must implement optimize(request)"], candidate: null };
	}

	let candidate: CandidatePatch;
	try {
		candidate = await engine.optimize(structuredClone(request));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, errors: [`engine threw during optimize: ${message}`], candidate: null };
	}

	const patchValidation = validateCandidatePatch(candidate, request.generatedRegions);
	return {
		ok: patchValidation.ok,
		errors: patchValidation.errors,
		candidate: patchValidation.ok ? patchValidation.value : null,
	};
}

/**
 * Conformance harness for engine implementations: the same request must
 * produce a byte-stable candidate bound to the requested regions. Run it
 * with a representative request before trusting a new engine.
 */
export async function runEngineConformance(
	engine: TrainingEngine,
	request: OptimizeRequest,
): Promise<{ ok: boolean; errors: readonly string[] }> {
	const errors: string[] = [];
	const first = await optimizeCandidate(engine, request);
	const second = await optimizeCandidate(engine, structuredClone(request));

	if (!first.ok) {
		errors.push(...first.errors);
	}
	if (!second.ok) {
		errors.push(...second.errors);
	}
	if (first.ok && second.ok && canonicalJson(first.candidate) !== canonicalJson(second.candidate)) {
		errors.push("determinism: same optimize request must return byte-stable candidate patch");
	}
	if (first.ok && first.candidate) {
		const requestedIds = new Set(request.generatedRegions.map((region) => region.regionId));
		const boundIds = new Set(first.candidate.regions.map((region) => region.regionId));
		if (requestedIds.size !== boundIds.size || [...requestedIds].some((id) => !boundIds.has(id))) {
			errors.push("candidate patch must bind to the requested generated regions");
		}
	}

	return { ok: errors.length === 0, errors };
}

export function validateOptimizeRequest(request: unknown): { ok: boolean; errors: readonly string[] } {
	const errors: string[] = [];

	if (!isRecord(request)) {
		return { ok: false, errors: ["optimize request must be an object"] };
	}
	if (request["schema"] !== OPTIMIZE_REQUEST_SCHEMA) {
		errors.push(`request.schema must be ${OPTIMIZE_REQUEST_SCHEMA}`);
	}
	if (!isNonEmptyString(request["requestId"])) {
		errors.push("request.requestId must be a non-empty string");
	}

	const regions = request["generatedRegions"];
	const regionIds = new Set<string>();
	if (!Array.isArray(regions) || regions.length === 0) {
		errors.push("request.generatedRegions must be a non-empty array");
	} else {
		regions.forEach((region, index) => {
			validateGeneratedRegionShape(region, errors, `request.generatedRegions.${index}`);
			const regionId = isRecord(region) ? region["regionId"] : undefined;
			if (isNonEmptyString(regionId)) {
				if (regionIds.has(regionId)) {
					errors.push(`request.generatedRegions.${index}.regionId must be unique`);
				}
				regionIds.add(regionId);
			}
		});
	}

	const regionSources = request["regionSources"];
	if (regionSources !== undefined) {
		if (!isRecord(regionSources)) {
			errors.push("request.regionSources must be an object");
		} else {
			for (const key of Object.keys(regionSources)) {
				if (!regionIds.has(key)) {
					errors.push(`request.regionSources.${key} must reference a requested region`);
				}
			}
		}
	}

	const trajectories = request["trajectories"];
	if (!Array.isArray(trajectories) || trajectories.length === 0) {
		errors.push("request.trajectories must be a non-empty array");
	} else {
		trajectories.forEach((trajectory, index) => {
			const validation = validateTrajectory(trajectory);
			if (!validation.ok) {
				errors.push(...validation.errors.map((error) => `trajectory ${index}: ${error}`));
			}
		});
	}
	const rubric = request["rubric"];
	if (!isRecord(rubric) || !isNonEmptyString(rubric["id"])) {
		errors.push("request.rubric.id must be a non-empty string");
	}
	const contract = request["contract"];
	if (!isRecord(contract) || !isNonEmptyString(contract["ref"])) {
		errors.push("request.contract.ref must be a non-empty string");
	}
	if (isRecord(contract)) {
		const allowed = contract["allowedRegionIds"];
		if (!Array.isArray(allowed)) {
			errors.push("request.contract.allowedRegionIds must be an array");
		} else {
			const allowedSet = new Set(allowed);
			const sameSize = allowedSet.size === regionIds.size;
			if (!sameSize || [...regionIds].some((id) => !allowedSet.has(id))) {
				errors.push("request.contract.allowedRegionIds must match request.generatedRegions region ids");
			}
		}
	}
	if (request["feedback"] !== undefined) {
		validateFeedbackList(request["feedback"], errors, "request.feedback");
	}

	return { ok: errors.length === 0, errors };
}

export function validateCandidatePatch(
	candidate: unknown,
	generatedRegions?: readonly GeneratedRegion[],
): ValidationResult<CandidatePatch> {
	const errors: string[] = [];

	if (!isRecord(candidate)) {
		return { ok: false, errors: ["candidate patch must be an object"], value: null };
	}
	if (candidate["schema"] !== CANDIDATE_PATCH_SCHEMA) {
		errors.push(`candidate.schema must be ${CANDIDATE_PATCH_SCHEMA}`);
	}
	if (!isNonEmptyString(candidate["id"])) {
		errors.push("candidate.id must be a non-empty string");
	}
	if (!isNonEmptyString(candidate["engineId"])) {
		errors.push("candidate.engineId must identify the optimizer");
	}

	const candidateRegions = candidate["regions"];
	const boundRegions = new Map<string, GeneratedRegion>();
	if (!Array.isArray(candidateRegions) || candidateRegions.length === 0) {
		errors.push("candidate.regions must be a non-empty array");
	} else {
		candidateRegions.forEach((region, index) => {
			validateGeneratedRegionShape(region, errors, `candidate.regions.${index}`);
			const regionId = isRecord(region) ? region["regionId"] : undefined;
			if (isNonEmptyString(regionId)) {
				boundRegions.set(regionId, region as unknown as GeneratedRegion);
			}
		});
	}

	// The regions the edits are checked against: the request's when supplied,
	// else the candidate's own bindings.
	const expectedRegions = new Map<string, GeneratedRegion>();
	if (generatedRegions) {
		for (const region of generatedRegions) {
			expectedRegions.set(region.regionId, region);
		}
		for (const [regionId, region] of boundRegions) {
			const expected = expectedRegions.get(regionId);
			if (!expected) {
				errors.push(`candidate.regions ${regionId} was not requested`);
				continue;
			}
			for (const key of ["regionId", "artifactRef", "startOffset", "endOffset"] as const) {
				if (region[key] !== expected[key]) {
					errors.push(`candidate region ${regionId} must match the requested generated region`);
					break;
				}
			}
		}
	} else {
		for (const [regionId, region] of boundRegions) {
			expectedRegions.set(regionId, region);
		}
	}

	const edits = candidate["edits"];
	if (!Array.isArray(edits) || edits.length === 0) {
		errors.push("candidate.edits must be a non-empty array");
	} else {
		edits.forEach((edit, index) => validateCandidateEdit(edit, index, expectedRegions, errors));
	}

	return {
		ok: errors.length === 0,
		errors,
		value: errors.length === 0 ? (structuredClone(candidate) as unknown as CandidatePatch) : null,
	};
}

function validateCandidateEdit(
	edit: unknown,
	index: number,
	regions: ReadonlyMap<string, GeneratedRegion>,
	errors: string[],
): void {
	if (!isRecord(edit)) {
		errors.push(`edit ${index} must be an object`);
		return;
	}
	const regionId = edit["regionId"];
	if (!isNonEmptyString(regionId)) {
		errors.push(`edit ${index}.regionId must name the region it rewrites`);
		return;
	}
	const region = regions.get(regionId);
	if (!region) {
		errors.push(`edit ${index}.regionId ${regionId} is not a requested region`);
		return;
	}
	const startOffset = edit["startOffset"];
	const endOffset = edit["endOffset"];
	if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset)) {
		errors.push(`edit ${index} offsets must be integers`);
		return;
	}
	if ((endOffset as number) < (startOffset as number)) {
		errors.push(`edit ${index}.endOffset must be greater than or equal to startOffset`);
	}
	if (!isNonEmptyString(edit["replacement"])) {
		errors.push(`edit ${index}.replacement must be a non-empty string`);
	}
	if ((startOffset as number) < region.startOffset || (endOffset as number) > region.endOffset) {
		errors.push(`edit ${index} must stay within generated region ${regionId}`);
	}
}
