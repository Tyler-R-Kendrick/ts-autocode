export {
	configureTraining,
	defaultEvolution,
	defaultObjective,
	defaultOutputDir,
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
	EvolveResult,
	TrainInput,
	Training,
	TrainingProviders,
	TrainingRun,
	TrainingSettings,
	TracingSettings,
} from "./training.js";

export { defaultMaxRounds, sequentialLoop } from "./loop.js";
export type {
	CandidateReview,
	ProposalTurn,
	ReviewContext,
	TrainingLoop,
	TrainingLoopInput,
	TrainingLoopRun,
	TrainingRound,
} from "./loop.js";

export type {
	MethodWeaver,
	PromotionResult,
	PromotionSnapshot,
	SourcePromoter,
	WeaveInvocation,
} from "./ports.js";

export { defineTrainable } from "./token.js";
export type { TrainableId, TrainableIdentity, TrainableToken } from "./token.js";

export { defaultTsconfig, discoverInSource, discoverTrainables, inMemoryArtifactRef, trainingMarker } from "./source.js";
export type { Marker, SourceSettings, TrainableTarget } from "./source.js";

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

export { createMemoryTrainingStore } from "./records.js";
export type { TrainingRecord, TrainingStore } from "./records.js";
