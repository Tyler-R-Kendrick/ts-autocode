export {
	captureTrainable,
	configureTraining,
	createTrainingRuntime,
	resetTraining,
	defaultEvolution,
	defaultObjective,
	defaultOutputDir,
	evaluationArgs,
	provideTrainingDefaults,
	training,
} from "./training.js";
export type {
	Activation,
	ActivationReadiness,
	AppliedPromotion,
	ConfigureOptions,
	PromotionSettings,
	RoundSettings,
	CaptureSettings,
	ErrorPhase,
	EvolutionSettings,
	ExecutionSettings,
	PromotionApplier,
	TrainInput,
	Training,
	TrainingEvent,
	TrainingProviders,
	TrainingRun,
	TrainingSettings,
	TracingSettings,
} from "./training.js";

export {
	CandidateSyntaxError,
	EngineContractError,
	EngineNotConfiguredError,
	EngineProposalError,
	ExecutorNotConfiguredError,
	InsufficientTracesError,
	InvalidSettingsError,
	InvalidTrainableIdentityError,
	isTsAutocodeError,
	LoopCapabilityError,
	MissingSecretError,
	OperationInterruptedError,
	parseSetting,
	PromotionApplierNotConfiguredError,
	PromotionRejectedError,
	SourceDiscoveryError,
	TraceNotFoundError,
	TrainingIncompleteError,
	TsAutocodeError,
	TsAutocodeSyntaxError,
	TsAutocodeTypeError,
} from "./errors.js";
export type { TsAutocodeErrorCode } from "./errors.js";

export { defaultRetry, OperationTimeoutError, withPolicy } from "./resilience.js";
export type { ResiliencePolicy, ResilienceSettings, RetryOptions } from "./resilience.js";

export { defaultFanOut, defaultMaxRounds, sequentialLoop, trainingRounds } from "./loop.js";
export type {
	CandidateReview,
	ProposalTurn,
	ReviewContext,
	RoundObserver,
	RoundSequence,
	TrainingLoop,
	TrainingLoopInput,
	TrainingLoopRun,
	TrainingRound,
} from "./loop.js";

export { defineTrainable, toTrainableToken, trainableTokenFromSymbol } from "./token.js";
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
	ModelSelection,
	OptimizeRequest,
	SecretProvider,
	TrainingEngine,
} from "./engine.js";

export type { TrainableEvalRun } from "./evaluation.js";

export { createCandidateReview, createEvalRun, createPromotionDecision } from "./builders.js";
export type { DecisionInput, EvalRunInput, ReviewInput } from "./builders.js";

export { defined, optional } from "./optional.js";

export { defaultMinPassRate, defaultMinScore, defaultPromotionGates, evaluatePromotionGate } from "./promotion.js";
export type { PromotionDecision, PromotionGate, PromotionGateContext, PromotionGateInput } from "./promotion.js";

export { MemoryTrainingStore } from "./records.js";
export type { TrainingRecord, TrainingStore } from "./records.js";
