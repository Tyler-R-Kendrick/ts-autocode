// ts-autocode — the code-evolution loop as a library.
//
// The loop: capture trajectories from a marker-delimited generated region →
// hand them to a training engine behind the optimizer port → screen the
// candidate patch offline against held-out data and contract invariants →
// pass the three-lens promotion gate (conformance, eval, policy) → promote
// champion/challenger style (auto-apply or PR delta) with log-driven revert.

export { canonicalJson, digest, DIGEST_PATTERN } from "./canonical.js";

export {
	DEFAULT_MARKER_PREFIX,
	RegionError,
	applyRegionEdits,
	checkGeneratedRegionDrift,
	findGeneratedRegion,
} from "./region.js";
export type { GeneratedRegion, RegionDriftReport, RegionEdit, RegionMarkerOptions } from "./region.js";

export {
	OPENINFERENCE_SPAN_KINDS,
	TRACEPARENT_PATTERN,
	TRAJECTORY_SCHEMA,
	hashTrajectory,
	validateTrajectory,
} from "./trajectory.js";
export type {
	Trajectory,
	TrajectoryPayload,
	TrajectoryReward,
	TrajectoryRun,
	TrajectorySpan,
	ValidationResult,
} from "./trajectory.js";

export {
	CANDIDATE_PATCH_SCHEMA,
	OPTIMIZE_REQUEST_SCHEMA,
	optimizeCandidate,
	runEngineConformance,
	validateCandidatePatch,
	validateOptimizeRequest,
} from "./engine.js";
export type {
	CandidatePatch,
	OptimizeContract,
	OptimizeOutcome,
	OptimizeRequest,
	Rubric,
	TrainingEngine,
} from "./engine.js";

export {
	BUILT_IN_ENGINE_ID,
	BUILT_IN_OPTO_ENGINE_CONTRACT,
	createBuiltInOptoEngine,
	evaluateCandidateOffline,
	parseRewriteProgram,
	predictLabel,
	runBuiltInOptoTrainingRun,
	screenCandidateForPromotion,
	validateCandidateRewriteContract,
} from "./optimizer.js";
export type {
	BuiltInOptoOptions,
	CandidateScreening,
	OfflineEvaluation,
	RewriteProgram,
	RewriteRule,
	TrainingRunResult,
} from "./optimizer.js";

export {
	TELEMETRY_ENVELOPE_SCHEMA,
	TRAINING_EVENT_SCHEMA,
	TRAINING_EVENT_TYPES,
	createTrainingEvent,
	replayTrainingRun,
	validateTrainingEvent,
} from "./events.js";
export type { CreateTrainingEventInput, TrainingEvent, TrainingEventType, TrainingRunProjection } from "./events.js";

export {
	PromotionGateParseError,
	evaluatePromotionGate,
	parseEvalResult,
	parsePromotionThresholds,
	promotionEventNames,
} from "./gate.js";
export type {
	ChampionChallenger,
	EvalResult,
	LensFlags,
	PromotionDecision,
	PromotionGateInput,
	PromotionOutcome,
	PromotionThresholds,
} from "./gate.js";

export {
	PROMOTION_SCHEMA,
	PROVENANCE_PAYLOAD_SCHEMA,
	PromotionError,
	createChampionChallengerPromotion,
	promoteCandidate,
	revertPromotion,
	validateSignedProvenance,
} from "./promotion.js";
export type {
	CertifiedGate,
	ChampionChallengerPromotion,
	PromoteInput,
	PromotionEvent,
	PromotionResult,
	RevertInput,
	RevertResult,
	ShadowSample,
	ShadowTrafficResult,
	SignedProvenance,
} from "./promotion.js";
