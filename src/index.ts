// ts-autocode — the code-evolution loop as a library, inspired by Microsoft
// Trace (OPTO: optimization with a trace oracle).
//
// The loop: wrap optimizable calls with trainable() so invocations record
// trajectories against marker-delimited generated regions → hand them to a
// training engine behind the optimizer port (with general feedback: scores,
// text, errors) → screen the candidate patch offline against held-out data
// and contract invariants (iterating via runOptimizationLoop) → pass the
// three-lens promotion gate (conformance, eval, policy) → promote
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
	validateFeedbackList,
	validateTrajectory,
} from "./trajectory.js";
export type {
	Feedback,
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
	CandidateEdit,
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

export { runOptimizationLoop } from "./loop.js";
export type { OptimizationLoopInput, OptimizationLoopResult, OptimizationRound } from "./loop.js";

export { renderOptimizeReport } from "./report.js";
export type { RenderOptimizeReportOptions } from "./report.js";

export {
	CAPTURE_CONTRACT,
	createCaptureRuntime,
	reconstructTrajectoryFromLog,
	recoverCandidateTrajectorySet,
	trainable,
} from "./capture.js";
export type {
	CaptureChildSpan,
	CaptureInvocationInput,
	CaptureMethod,
	CaptureResult,
	CaptureRun,
	CaptureRuntime,
	CaptureRuntimeOptions,
	TrainableFunction,
	TrainableOptions,
} from "./capture.js";

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
	createEd25519ProvenanceVerifier,
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
	ProvenanceVerifier,
	RevertInput,
	RevertResult,
	ShadowSample,
	ShadowTrafficResult,
	SignedProvenance,
} from "./promotion.js";
