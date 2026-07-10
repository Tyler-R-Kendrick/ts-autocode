import { canonicalJson, isNonEmptyString, isRecord } from "./canonical.js";
import type { GeneratedRegion, RegionEdit } from "./region.js";
import {
	type Trajectory,
	type ValidationResult,
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
	readonly allowedRegionId: string;
	readonly invariants?: {
		readonly allowedOutputs?: readonly string[];
		readonly forbiddenOutputs?: readonly string[];
		readonly requiredFallback?: string;
	};
}

/** Everything an engine gets: the region to rewrite, evidence, rubric, contract. */
export interface OptimizeRequest {
	readonly schema: typeof OPTIMIZE_REQUEST_SCHEMA;
	readonly requestId: string;
	readonly generatedRegion: GeneratedRegion;
	readonly trajectories: readonly Trajectory[];
	readonly rubric: Rubric;
	readonly contract: OptimizeContract;
}

/**
 * The only thing an engine may return: edits strictly inside the requested
 * generated region, with provenance for the audit trail.
 */
export interface CandidatePatch {
	readonly schema: typeof CANDIDATE_PATCH_SCHEMA;
	readonly id: string;
	readonly engineId: string;
	readonly region: GeneratedRegion;
	readonly edits: readonly RegionEdit[];
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
 */
export interface TrainingEngine {
	readonly engineId: string;
	optimize(request: OptimizeRequest): CandidatePatch;
}

export interface OptimizeOutcome {
	readonly ok: boolean;
	readonly errors: readonly string[];
	readonly candidate: CandidatePatch | null;
}

/**
 * Runs an engine against a validated request and validates the returned
 * patch. The engine receives a deep clone, so it cannot mutate the caller's
 * request, and an engine that throws is reported, not propagated.
 */
export function optimizeCandidate(engine: TrainingEngine, request: OptimizeRequest): OptimizeOutcome {
	const requestValidation = validateOptimizeRequest(request);
	if (!requestValidation.ok) {
		return { ok: false, errors: requestValidation.errors, candidate: null };
	}
	if (!engine || typeof engine.optimize !== "function") {
		return { ok: false, errors: ["engine must implement optimize(request)"], candidate: null };
	}

	let candidate: CandidatePatch;
	try {
		candidate = engine.optimize(structuredClone(request));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, errors: [`engine threw during optimize: ${message}`], candidate: null };
	}

	const patchValidation = validateCandidatePatch(candidate, request.generatedRegion);
	return {
		ok: patchValidation.ok,
		errors: patchValidation.errors,
		candidate: patchValidation.ok ? patchValidation.value : null,
	};
}

/**
 * Conformance harness for engine implementations: the same request must
 * produce a byte-stable candidate bound to the requested region. Run it with
 * a representative request before trusting a new engine.
 */
export function runEngineConformance(engine: TrainingEngine, request: OptimizeRequest): { ok: boolean; errors: readonly string[] } {
	const errors: string[] = [];
	const first = optimizeCandidate(engine, request);
	const second = optimizeCandidate(engine, structuredClone(request));

	if (!first.ok) {
		errors.push(...first.errors);
	}
	if (!second.ok) {
		errors.push(...second.errors);
	}
	if (first.ok && second.ok && canonicalJson(first.candidate) !== canonicalJson(second.candidate)) {
		errors.push("determinism: same optimize request must return byte-stable candidate patch");
	}
	if (first.ok && first.candidate && first.candidate.region.regionId !== request.generatedRegion.regionId) {
		errors.push("candidate patch must bind to the requested generated region");
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
	validateGeneratedRegionShape(request["generatedRegion"], errors, "request.generatedRegion");
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
	const generatedRegion = request["generatedRegion"];
	if (
		!isRecord(contract) ||
		!isRecord(generatedRegion) ||
		contract["allowedRegionId"] !== generatedRegion["regionId"]
	) {
		errors.push("request.contract.allowedRegionId must match request.generatedRegion.regionId");
	}

	return { ok: errors.length === 0, errors };
}

export function validateCandidatePatch(
	candidate: unknown,
	generatedRegion?: GeneratedRegion,
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

	validateGeneratedRegionShape(candidate["region"], errors, "candidate.region");
	const region = candidate["region"];
	const expectedRegion = generatedRegion ?? (isRecord(region) ? (region as unknown as GeneratedRegion) : undefined);
	if (generatedRegion) {
		validateGeneratedRegionShape(generatedRegion, errors, "generated region");
	}
	if (isRecord(region) && expectedRegion) {
		for (const key of ["regionId", "artifactRef", "startOffset", "endOffset"] as const) {
			if (region[key] !== expectedRegion[key]) {
				errors.push("candidate.region must match generated region");
				break;
			}
		}
	}

	const edits = candidate["edits"];
	if (!Array.isArray(edits) || edits.length === 0) {
		errors.push("candidate.edits must be a non-empty array");
	} else {
		edits.forEach((edit, index) => validateCandidateEdit(edit, index, expectedRegion, errors));
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
	region: GeneratedRegion | undefined,
	errors: string[],
): void {
	if (!isRecord(edit)) {
		errors.push(`edit ${index} must be an object`);
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
	if (region && ((startOffset as number) < region.startOffset || (endOffset as number) > region.endOffset)) {
		errors.push(`edit ${index} must stay within generated region`);
	}
}
