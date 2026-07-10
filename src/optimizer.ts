import { digest } from "./canonical.js";
import {
	CANDIDATE_PATCH_SCHEMA,
	type CandidatePatch,
	type OptimizeContract,
	type OptimizeRequest,
	type Rubric,
	type TrainingEngine,
	optimizeCandidate,
	validateCandidatePatch,
} from "./engine.js";
import { type Trajectory, hashTrajectory } from "./trajectory.js";
import {
	type TrainingEvent,
	createTrainingEvent,
} from "./events.js";

export const BUILT_IN_ENGINE_ID = "ts-autocode.training-engine/built-in-opto@0.1.0";
export const BUILT_IN_OPTO_ENGINE_CONTRACT = "ts-autocode.built-in-opto-training-engine/v1";

const DEFAULT_STOPWORDS = new Set([
	"about",
	"again",
	"copy",
	"from",
	"general",
	"help",
	"issue",
	"needed",
	"please",
	"question",
	"request",
	"route",
	"status",
	"support",
	"ticket",
	"with",
]);

export interface RewriteRule {
	readonly label: string;
	readonly keywords: readonly string[];
}

export interface BuiltInOptoOptions {
	readonly engineId?: string;
	/** Tokens ignored when deriving keywords from mislabeled examples. */
	readonly stopwords?: ReadonlySet<string>;
	/** Keywords kept per derived rule (most frequent first). */
	readonly maxKeywordsPerRule?: number;
	/** Label returned when no rule matches and the contract names no fallback. */
	readonly defaultFallbackLabel?: string;
}

/**
 * The built-in OPTO-style engine: a deterministic reference optimizer that
 * derives keyword→label rewrite rules from the trajectories where the
 * baseline got the label wrong, and renders them as a replacement program
 * for the generated region.
 *
 * Trajectories feed it through payloads: `input` (the routed text),
 * `expectedLabel` (ground truth), and `baselineLabel` (what the current
 * champion produced). It exists to prove the loop end to end; production
 * engines (LLM rewriters, RL trainers) implement the same TrainingEngine port.
 */
export function createBuiltInOptoEngine({
	engineId = BUILT_IN_ENGINE_ID,
	stopwords = DEFAULT_STOPWORDS,
	maxKeywordsPerRule = 4,
	defaultFallbackLabel = "fallback",
}: BuiltInOptoOptions = {}): TrainingEngine {
	return Object.freeze({
		engineId,
		optimize(request: OptimizeRequest): CandidatePatch {
			const rules = deriveRewriteRules(request.trajectories, stopwords, maxKeywordsPerRule);
			const replacement = renderRewriteProgram(
				rules,
				request.contract.invariants?.requiredFallback ?? defaultFallbackLabel,
			);
			const candidateCore = {
				engineId,
				region: structuredClone(request.generatedRegion),
				rules,
				replacement,
				requestId: request.requestId,
			};

			return {
				schema: CANDIDATE_PATCH_SCHEMA,
				id: `candidate-opto-${digest(candidateCore).slice(7, 19)}`,
				engineId,
				region: structuredClone(request.generatedRegion),
				edits: [
					{
						startOffset: request.generatedRegion.startOffset,
						endOffset: request.generatedRegion.endOffset,
						replacement,
					},
				],
				provenance: {
					optimizer: BUILT_IN_OPTO_ENGINE_CONTRACT,
					trajectoryHashes: request.trajectories.map(hashTrajectory),
					rubricRef: request.rubric.id,
					contractRef: request.contract.ref,
					selectedRules: rules,
				},
			};
		},
	});
}

export interface OfflineEvaluation {
	readonly baselineScore: number;
	readonly candidateScore: number;
	readonly improvement: number;
	readonly passed: boolean;
	readonly decisions: readonly {
		readonly trajectoryId: string;
		readonly expectedLabel: string | undefined;
		readonly baselineLabel: string | undefined;
		readonly candidateLabel: string | undefined;
		readonly baselineCorrect: boolean;
		readonly candidateCorrect: boolean;
	}[];
	readonly rejectionReasons: readonly string[];
}

export interface CandidateScreening {
	readonly outcome: "ready-for-gate" | "rejected";
	readonly passFlags: {
		readonly conformance: boolean;
		readonly heldOutEval: boolean;
	};
	readonly evaluation: OfflineEvaluation;
	readonly rejectionReasons: readonly string[];
}

export interface TrainingRunResult {
	readonly schema: typeof BUILT_IN_OPTO_ENGINE_CONTRACT;
	readonly outcome: "ready-for-gate" | "rejected";
	readonly candidate: CandidatePatch | null;
	readonly screening: CandidateScreening | null;
	readonly evaluation: OfflineEvaluation | null;
	readonly events: readonly TrainingEvent[];
	readonly replayDigest: string;
	readonly rejectionReasons: readonly string[];
}

/**
 * One full offline training run: optimize → validate patch → check contract
 * invariants → evaluate on held-out trajectories. The output is either
 * `ready-for-gate` (hand the candidate to the promotion gate) or `rejected`
 * with every reason recorded.
 */
export function runBuiltInOptoTrainingRun({
	request,
	heldOutTrajectories,
	engine = createBuiltInOptoEngine(),
}: {
	request: OptimizeRequest;
	heldOutTrajectories: readonly Trajectory[];
	engine?: TrainingEngine;
}): TrainingRunResult {
	const optimized = optimizeCandidate(engine, request);
	if (!optimized.ok || optimized.candidate === null) {
		return {
			schema: BUILT_IN_OPTO_ENGINE_CONTRACT,
			outcome: "rejected",
			candidate: null,
			screening: null,
			evaluation: null,
			events: [],
			replayDigest: digest({ requestId: request?.requestId, errors: optimized.errors }),
			rejectionReasons: optimized.errors,
		};
	}

	const screening = screenCandidateForPromotion({
		request,
		candidate: optimized.candidate,
		heldOutTrajectories,
	});
	const events = trainingRunEvents({ request, candidate: optimized.candidate, screening });

	return {
		schema: BUILT_IN_OPTO_ENGINE_CONTRACT,
		outcome: screening.outcome,
		candidate: optimized.candidate,
		screening,
		evaluation: screening.evaluation,
		events,
		replayDigest: digest({ events }),
		rejectionReasons: screening.rejectionReasons,
	};
}

/**
 * The offline screen before the promotion gate: the patch must stay in
 * region, honor the contract invariants, and beat the baseline on held-out
 * trajectories by the rubric's margins.
 */
export function screenCandidateForPromotion({
	request,
	candidate,
	heldOutTrajectories,
}: {
	request: OptimizeRequest;
	candidate: CandidatePatch;
	heldOutTrajectories: readonly Trajectory[];
}): CandidateScreening {
	const patch = validateCandidatePatch(candidate, request.generatedRegion);
	const patchErrors = patch.ok ? [] : [...patch.errors];
	const contractCheck = patch.ok
		? validateCandidateRewriteContract(candidate, request.contract)
		: { ok: false, reasons: [] as string[] };
	const evaluation = evaluateCandidateOffline({
		candidate,
		heldOutTrajectories,
		rubric: request.rubric,
		conformanceOk: patch.ok && contractCheck.ok,
	});

	const rejectionReasons = [...patchErrors, ...contractCheck.reasons, ...evaluation.rejectionReasons];
	const conformance = patch.ok && contractCheck.ok;
	const heldOutEval = conformance && evaluation.passed;

	return {
		outcome: conformance && heldOutEval ? "ready-for-gate" : "rejected",
		passFlags: { conformance, heldOutEval },
		evaluation,
		rejectionReasons,
	};
}

/** Scores the candidate program against held-out trajectories. */
export function evaluateCandidateOffline({
	candidate,
	heldOutTrajectories,
	rubric,
	conformanceOk = true,
}: {
	candidate: CandidatePatch;
	heldOutTrajectories: readonly Trajectory[];
	rubric: Rubric;
	conformanceOk?: boolean;
}): OfflineEvaluation {
	const trajectories = Array.isArray(heldOutTrajectories) ? heldOutTrajectories : [];
	if (trajectories.length === 0) {
		return {
			baselineScore: 0,
			candidateScore: 0,
			improvement: 0,
			passed: false,
			decisions: [],
			rejectionReasons: ["held-out.required"],
		};
	}

	const program = parseRewriteProgram(candidateReplacement(candidate));
	const decisions = trajectories.map((trajectory) => {
		const expectedLabel = extractExpectedLabel(trajectory);
		const baselineLabel = extractBaselineLabel(trajectory);
		const candidateLabel = predictLabel(program, extractInput(trajectory));
		return {
			trajectoryId: trajectory.id,
			expectedLabel,
			baselineLabel,
			candidateLabel,
			baselineCorrect: baselineLabel === expectedLabel,
			candidateCorrect: candidateLabel === expectedLabel,
		};
	});

	const baselineScore = average(decisions.map((decision) => Number(decision.baselineCorrect)));
	const candidateScore = conformanceOk ? average(decisions.map((decision) => Number(decision.candidateCorrect))) : 0;
	const improvement = candidateScore - baselineScore;
	const minimumImprovement = Number.isFinite(rubric?.minimumImprovement) ? (rubric.minimumImprovement as number) : 0;
	const heldOutThreshold = Number.isFinite(rubric?.heldOutThreshold) ? (rubric.heldOutThreshold as number) : 0;
	const rejectionReasons: string[] = [];

	if (improvement < minimumImprovement) {
		rejectionReasons.push(`held-out.improvement-below:${minimumImprovement}`);
	}
	if (candidateScore < heldOutThreshold) {
		rejectionReasons.push(`held-out.score-below:${heldOutThreshold}`);
	}

	return {
		baselineScore,
		candidateScore,
		improvement,
		passed: rejectionReasons.length === 0,
		decisions,
		rejectionReasons,
	};
}

export interface RewriteProgram {
	readonly rules: readonly RewriteRule[];
	readonly fallback: string | undefined;
	readonly returnedLabels: readonly string[];
	readonly parseErrors: readonly string[];
}

/** Parses a rendered rewrite program back into its rules — the contract check reads code, not intent. */
export function parseRewriteProgram(source: string): RewriteProgram {
	const rules: RewriteRule[] = [];
	const parseErrors: string[] = [];
	const rulePattern =
		/^if \((\[[^\]]+\])\.some\(\(keyword\) => normalized\.includes\(keyword\)\)\) return "([^"]+)";$/gm;
	for (const match of source.matchAll(rulePattern)) {
		try {
			const keywords: unknown = JSON.parse(match[1] as string);
			if (
				!Array.isArray(keywords) ||
				keywords.some((keyword) => typeof keyword !== "string" || keyword.length === 0)
			) {
				parseErrors.push("contract.keyword-list-invalid");
				continue;
			}
			rules.push({ keywords: keywords as string[], label: match[2] as string });
		} catch {
			parseErrors.push("contract.keyword-list-invalid");
		}
	}

	const returnedLabels = [...source.matchAll(/return "([^"]+)";/g)].map((match) => match[1] as string);
	return {
		rules,
		fallback: returnedLabels.at(-1),
		returnedLabels: [...new Set(returnedLabels)],
		parseErrors,
	};
}

/** Executes a parsed rewrite program against an input string. */
export function predictLabel(program: RewriteProgram, input: string): string | undefined {
	const normalized = input.toLowerCase();
	for (const rule of program.rules) {
		if (rule.keywords.some((keyword) => normalized.includes(keyword))) {
			return rule.label;
		}
	}
	return program.fallback;
}

export function validateCandidateRewriteContract(
	candidate: CandidatePatch,
	contract: OptimizeContract,
): { ok: boolean; reasons: string[] } {
	const program = parseRewriteProgram(candidateReplacement(candidate));
	const allowedLabels = new Set(contract?.invariants?.allowedOutputs ?? []);
	const forbiddenLabels = new Set(contract?.invariants?.forbiddenOutputs ?? []);
	const reasons = [...program.parseErrors];

	for (const label of program.returnedLabels) {
		if (forbiddenLabels.has(label)) {
			reasons.push(`contract.forbidden-output:${label}`);
		}
		if (allowedLabels.size > 0 && !allowedLabels.has(label)) {
			reasons.push(`contract.unapproved-output:${label}`);
		}
	}

	const requiredFallback = contract?.invariants?.requiredFallback;
	if (requiredFallback && program.fallback !== requiredFallback) {
		reasons.push(`contract.required-fallback:${requiredFallback}`);
	}
	if (program.rules.length === 0) {
		reasons.push("contract.rules-required");
	}

	return { ok: reasons.length === 0, reasons };
}

function deriveRewriteRules(
	trajectories: readonly Trajectory[],
	stopwords: ReadonlySet<string>,
	maxKeywordsPerRule: number,
): RewriteRule[] {
	const byLabel = new Map<string, Map<string, number>>();
	for (const trajectory of trajectories) {
		const expectedLabel = extractExpectedLabel(trajectory);
		if (!expectedLabel || extractBaselineLabel(trajectory) === expectedLabel) {
			continue;
		}

		const labelTokens = byLabel.get(expectedLabel) ?? new Map<string, number>();
		for (const token of inputTokens(extractInput(trajectory), stopwords)) {
			labelTokens.set(token, (labelTokens.get(token) ?? 0) + 1);
		}
		byLabel.set(expectedLabel, labelTokens);
	}

	return [...byLabel.entries()]
		.map(([label, tokenCounts]) => ({
			label,
			keywords: [...tokenCounts.entries()]
				.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
				.slice(0, maxKeywordsPerRule)
				.map(([token]) => token),
		}))
		.filter((rule) => rule.keywords.length > 0)
		.sort((left, right) => left.label.localeCompare(right.label));
}

function renderRewriteProgram(rules: readonly RewriteRule[], fallbackLabel: string): string {
	const lines = ["// ts-autocode:opto-rules v1", "const normalized = input.toLowerCase();"];

	for (const rule of rules) {
		lines.push(
			`if (${JSON.stringify(rule.keywords)}.some((keyword) => normalized.includes(keyword))) return ${JSON.stringify(rule.label)};`,
		);
	}

	lines.push(`return ${JSON.stringify(fallbackLabel)};`);
	return lines.join("\n");
}

function candidateReplacement(candidate: CandidatePatch): string {
	if (!Array.isArray(candidate?.edits)) {
		return "";
	}
	return candidate.edits.map((edit) => (typeof edit?.replacement === "string" ? edit.replacement : "")).join("\n");
}

function trainingRunEvents({
	request,
	candidate,
	screening,
}: {
	request: OptimizeRequest;
	candidate: CandidatePatch;
	screening: CandidateScreening;
}): TrainingEvent[] {
	const runId = request.requestId;
	return [
		createTrainingEvent({
			id: `${runId}-started`,
			type: "training.RunStarted",
			runId,
			seq: 0,
			data: {
				requestId: request.requestId,
				engineId: candidate.engineId,
			},
		}),
		createTrainingEvent({
			id: `${runId}-candidate-proposed`,
			type: "training.CandidateProposed",
			runId,
			seq: 1,
			data: { candidate },
		}),
		createTrainingEvent({
			id: `${runId}-candidate-evaluated`,
			type: "training.CandidateEvaluated",
			runId,
			seq: 2,
			data: {
				candidateId: candidate.id,
				conformance: {
					ok: screening.passFlags.conformance,
					errors: screening.rejectionReasons,
				},
				heldOutEval: screening.evaluation,
			},
		}),
	];
}

function extractInput(trajectory: Trajectory): string {
	return (
		payloadValue(trajectory, "input") ??
		stringOrUndefined(trajectory.spans?.[0]?.inputs?.["input"]) ??
		stringOrUndefined(trajectory.spans?.[0]?.attributes?.["input.value"]) ??
		""
	);
}

function extractExpectedLabel(trajectory: Trajectory): string | undefined {
	return payloadValue(trajectory, "expectedLabel");
}

function extractBaselineLabel(trajectory: Trajectory): string | undefined {
	return payloadValue(trajectory, "baselineLabel") ?? stringOrUndefined(trajectory.spans?.[0]?.outputs?.["label"]);
}

function payloadValue(trajectory: Trajectory, key: string): string | undefined {
	const payload = trajectory.payloads?.[key];
	if (!payload || typeof payload !== "object") {
		return undefined;
	}
	return typeof payload.value === "string" ? payload.value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function inputTokens(input: string, stopwords: ReadonlySet<string>): string[] {
	return [...new Set(input.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter(
		(token) => token.length >= 4 && !stopwords.has(token),
	);
}

function average(values: readonly number[]): number {
	if (values.length === 0) {
		return 0;
	}
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}
