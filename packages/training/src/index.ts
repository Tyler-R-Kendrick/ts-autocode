export {
	captureTrainable,
	configureTraining,
	defaultEvolution,
	defaultObjective,
	defaultOutputDir,
	provideTrainingDefaults,
	training,
} from "./training.js";
export type {
	Activation,
	AppliedPromotion,
	CaptureSettings,
	EvolutionSettings,
	PromotionApplier,
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

export { defineTrainable, trainableTokenFromSymbol } from "./token.js";
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
