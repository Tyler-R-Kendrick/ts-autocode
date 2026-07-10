export { applyCandidate, optimizeCandidate } from "./engine.js";
export type {
	BoundEvaluation,
	CandidateEdit,
	CandidatePatch,
	EngineContext,
	OptimizeRequest,
	SecretProvider,
	TrainingEngine,
} from "./engine.js";

export { evaluateTrainable } from "./evaluation.js";
export type { TrainableEvalRun } from "./evaluation.js";

export {
	evaluatePromotionGate,
	promoteCandidate,
	revertPromotion,
} from "./promotion.js";
export type {
	PromotionDecision,
	PromotionGateInput,
	PromotionResult,
	PromotionSnapshot,
} from "./promotion.js";

export { findGeneratedRegion } from "./region.js";
export type { GeneratedRegion, RegionMarkerOptions } from "./region.js";

export { createMemoryTrainingStore } from "./records.js";
export type { TrainingRecord, TrainingStore } from "./records.js";

export { defineTrainable } from "./token.js";
export type { TrainableId, TrainableToken } from "./token.js";

export {
	TrainingSession,
	createTraining,
	trainable,
	useTraining,
} from "./training.js";
export type {
	BoundTrainableOptions,
	CaptureSettings,
	OptimizeInput,
	TrainableDecorator,
	TrainableOptions,
	TrainingSettings,
} from "./training.js";
