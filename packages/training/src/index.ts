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
	TrainingRun,
	TrainingSettings,
	TracingSettings,
} from "./training.js";

export type {
	CandidateReview,
	ProposalTurn,
	ReviewContext,
	TrainingLoop,
	TrainingLoopInput,
	TrainingLoopRun,
	TrainingRound,
} from "./loop.js";

export { defineTrainable } from "./token.js";
export type { TrainableId, TrainableIdentity, TrainableToken } from "./token.js";

export { discoverInSource, discoverTrainables, trainingMarker } from "./source.js";
export type { SourceSettings, TrainableTarget } from "./source.js";

export { candidateDeclaration } from "./engine.js";
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

export type { TrainableEvalRun } from "./evaluation.js";

export { evaluatePromotionGate } from "./promotion.js";
export type { PromotionDecision, PromotionGateInput } from "./promotion.js";

export type { PromotionResult, PromotionSnapshot } from "ts-autocode-rewrite";

export { createMemoryTrainingStore } from "./records.js";
export type { TrainingRecord, TrainingStore } from "./records.js";
