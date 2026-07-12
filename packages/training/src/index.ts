export {
	configureTraining,
	instrumentTrainable,
	provideTrainingDefaults,
	trainable,
	training,
	wrapTrainable,
} from "./training.js";
export type {
	CaptureSettings,
	CandidateEvalConfig,
	EvolutionSettings,
	EvolveInput,
	EvolveResult,
	OptimizeInput,
	TrainInput,
	Training,
	TrainingProviders,
	TrainingRound,
	TrainingRun,
	TrainingSettings,
	TracingSettings,
} from "./training.js";

export { defineTrainable } from "./token.js";
export type { TrainableId, TrainableIdentity, TrainableToken } from "./token.js";

export { discoverInSource, discoverTrainables } from "./source.js";
export type { SourceSettings, TrainableTarget } from "./source.js";

export { applyCandidate } from "./engine.js";
export type {
	BoundEvaluation,
	CandidatePatch,
	EngineCandidate,
	EngineContext,
	ImplementationExecutor,
	OptimizeRequest,
	SecretProvider,
	TrainingEngine,
} from "./engine.js";

export { evaluatePromotionGate, promoteCandidate, revertPromotion } from "./promotion.js";
export type {
	PromotionDecision,
	PromotionGateInput,
	PromotionResult,
	PromotionSnapshot,
} from "./promotion.js";

export { createMemoryTrainingStore } from "./records.js";
export type { TrainingRecord, TrainingStore } from "./records.js";
