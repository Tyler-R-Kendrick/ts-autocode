import { isNonEmptyString, isRecord } from "./canonical.js";
import type { Score } from "./trajectory.js";

// The champion/challenger promotion gate. A candidate promotes only through
// the three-lens gate: conformance (hard contract) green AND eval thresholds
// met over enough samples AND policy allows. The trace lens rides the event
// log, so it is not a flag here.

export class PromotionGateParseError extends Error {
	readonly path: string;
	readonly expected: string;
	readonly received: unknown;

	constructor(path: string, expected: string, received: unknown, message?: string) {
		super(message ?? `${path}: expected ${expected}, received ${JSON.stringify(received)}`);
		this.name = "PromotionGateParseError";
		this.path = path;
		this.expected = expected;
		this.received = received;
	}
}

/** A live-eval / held-out / adversarial rubric score over a sample window. */
export interface EvalResult {
	readonly rubricRef: string;
	/** Where the scores came from (e.g. "live-eval", "shadow", "human-label"). */
	readonly source: string;
	readonly sampleCount: number;
	/** Metric name → score in [0, 1]. */
	readonly scores: Readonly<Record<string, number>>;
}

/** Metric floors and the minimum sample count the eval lens requires. */
export interface PromotionThresholds {
	readonly minSamples: number;
	/** Metric name → floor in [0, 1]; every named metric must be present and at/above its floor. */
	readonly metricFloors: Readonly<Record<string, number>>;
}

export interface LensFlags {
	readonly conformance: boolean;
	readonly eval: boolean;
	readonly policy: boolean;
}

export interface ChampionChallenger {
	readonly championId: string;
	readonly challengerId: string;
}

export type PromotionOutcome = "promote" | "refuse";

export interface PromotionDecision {
	readonly candidateId: string;
	readonly outcome: PromotionOutcome;
	readonly passed: LensFlags;
	readonly failures: readonly string[];
	readonly championChallenger: ChampionChallenger;
}

export interface PromotionGateInput {
	readonly candidateId: string;
	/** Conformance lens: the hard contract (conformance suite) is green. */
	readonly conformance: boolean;
	/** Policy lens: tenant/environment policy allows the promotion. */
	readonly policy: boolean;
	readonly evalResult: EvalResult;
	readonly thresholds: PromotionThresholds;
	readonly championId?: string;
}

function fail(path: string, expected: string, received: unknown): never {
	throw new PromotionGateParseError(path, expected, received);
}

function nonEmpty(value: unknown, path: string): string {
	if (!isNonEmptyString(value)) fail(path, "non-empty string", value);
	return value;
}

function unitInterval(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
		fail(path, "number in [0, 1]", value);
	}
	return value;
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const nested of Object.values(value)) deepFreeze(nested);
		Object.freeze(value);
	}
	return value;
}

/** Parses an untrusted eval result at the boundary (parse, don't validate). */
export function parseEvalResult(value: unknown): EvalResult {
	if (!isRecord(value)) fail("evalResult", "object", value);
	const rubricRef = nonEmpty(value["rubricRef"], "evalResult.rubricRef");
	const source = nonEmpty(value["source"], "evalResult.source");
	const sampleCount = value["sampleCount"];
	if (!Number.isInteger(sampleCount) || (sampleCount as number) < 0) {
		fail("evalResult.sampleCount", "non-negative integer", sampleCount);
	}
	const scoresRaw = value["scores"] ?? {};
	if (!isRecord(scoresRaw)) fail("evalResult.scores", "object", scoresRaw);
	const scores: Record<string, number> = {};
	for (const [metric, score] of Object.entries(scoresRaw)) {
		scores[metric] = unitInterval(score, `evalResult.scores.${metric}`);
	}
	return deepFreeze({ rubricRef, source, sampleCount: sampleCount as number, scores });
}

/** Parses untrusted gate configuration at the boundary. */
export function parsePromotionThresholds(value: unknown): PromotionThresholds {
	if (!isRecord(value)) fail("promotionThresholds", "object", value);
	const minSamples = value["minSamples"];
	if (!Number.isInteger(minSamples) || (minSamples as number) < 0) {
		fail("promotionThresholds.minSamples", "non-negative integer", minSamples);
	}
	const floorsRaw = value["metricFloors"] ?? {};
	if (!isRecord(floorsRaw)) fail("promotionThresholds.metricFloors", "object", floorsRaw);
	const metricFloors: Record<string, number> = {};
	for (const [metric, floor] of Object.entries(floorsRaw)) {
		metricFloors[metric] = unitInterval(floor, `promotionThresholds.metricFloors.${metric}`);
	}
	return deepFreeze({ minSamples: minSamples as number, metricFloors });
}

/**
 * The three-lens promotion decision. A challenger promotes over the champion
 * only when conformance is green, every metric floor is met over at least the
 * minimum sample count, and policy allows; otherwise it is refused with the
 * failing lenses recorded.
 */
export function evaluatePromotionGate(input: PromotionGateInput): PromotionDecision {
	nonEmpty(input.candidateId, "candidateId");
	const failures: string[] = [];

	if (!input.conformance) {
		failures.push("conformance: hard contract not green");
	}

	let evalPassed = true;
	if (input.evalResult.sampleCount < input.thresholds.minSamples) {
		evalPassed = false;
		failures.push(`eval: ${input.evalResult.sampleCount} samples below min ${input.thresholds.minSamples}`);
	}
	for (const [metric, floor] of Object.entries(input.thresholds.metricFloors)) {
		const score = input.evalResult.scores[metric];
		if (score === undefined) {
			evalPassed = false;
			failures.push(`eval: metric ${metric} missing from eval result`);
		} else if (score < floor) {
			evalPassed = false;
			failures.push(`eval: ${metric} ${score} below floor ${floor}`);
		}
	}

	if (!input.policy) {
		failures.push("policy: promotion not allowed by policy");
	}

	const promoted = failures.length === 0;

	return deepFreeze({
		candidateId: input.candidateId,
		outcome: promoted ? "promote" : ("refuse" as PromotionOutcome),
		passed: {
			conformance: input.conformance,
			eval: evalPassed,
			policy: input.policy,
		},
		failures,
		championChallenger: {
			championId: input.championId ?? "",
			challengerId: input.candidateId,
		},
	});
}

/**
 * Aggregates captured trajectory scores into an EvalResult for the gate:
 * numeric scores average per name; boolean scores average as 0/1; categorical
 * scores are skipped (they have no floor semantics). sampleCount is the
 * number of scores contributing to the largest metric group.
 */
export function evalResultFromScores(
	scores: readonly Score[],
	{ rubricRef, source }: { rubricRef: string; source: string },
): EvalResult {
	const sums = new Map<string, { total: number; count: number }>();
	for (const score of scores) {
		const numeric =
			typeof score.value === "number" ? score.value : typeof score.value === "boolean" ? Number(score.value) : null;
		if (numeric === null) {
			continue;
		}
		const entry = sums.get(score.name) ?? { total: 0, count: 0 };
		entry.total += numeric;
		entry.count += 1;
		sums.set(score.name, entry);
	}
	const aggregated: Record<string, number> = {};
	let sampleCount = 0;
	for (const [name, { total, count }] of sums) {
		aggregated[name] = total / count;
		sampleCount = Math.max(sampleCount, count);
	}
	return parseEvalResult({ rubricRef, source, sampleCount, scores: aggregated });
}

// Past-tense facts a decision emits; the decision is the source of truth, so
// the mapping is total over its outcome.
const TRAINING_PROMOTED = "training.Promoted";
const IMPL_PROMOTED = "impl.Promoted";
const EVAL_GATE_FAILED = "eval.GateFailed";

/**
 * The event names a promotion decision emits: a promote publishes both the
 * training-run and generated-impl promotion facts; a refusal publishes the
 * eval-gate failure.
 */
export function promotionEventNames(decision: PromotionDecision): readonly string[] {
	switch (decision.outcome) {
		case "promote":
			return [TRAINING_PROMOTED, IMPL_PROMOTED];
		case "refuse":
			return [EVAL_GATE_FAILED];
		default:
			return [];
	}
}
