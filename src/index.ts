import { provideTrainingDefaults } from "ts-autocode-training";

import { executeImplementation } from "./execution.js";
import { createAxEngine } from "./providers/ax.js";
import { createHarnessLoop } from "./providers/harness.js";
import { configureRewriteCapture, rewritePromotion } from "./providers/rewrite.js";

// This package connects the provider-neutral training runtime to its concrete
// providers: Ax optimizes and executes candidates, the governed agent harness
// drives training rounds, and the rewrite package intercepts marked methods
// into runtime capture and applies gated promotions. The sibling packages
// never import each other; they meet only here.
provideTrainingDefaults({
	engine: () => createAxEngine(),
	executor: executeImplementation,
	loop: createHarnessLoop(),
	promote: rewritePromotion,
});
configureRewriteCapture();

export { createHarnessLoop, defaultActionLogDir } from "./providers/harness.js";
export type { HarnessLoopOptions } from "./providers/harness.js";
export { defaultContextWindow, windowedContext } from "./providers/context.js";
export { configureRewriteCapture, rewritePromotion } from "./providers/rewrite.js";
export { instrumentTrainable, trainable, wrapTrainable } from "./instrumentation.js";
export type { TrainableDecorator } from "./instrumentation.js";

// The re-export lists below are exhaustive by contract: `test/surface.test.ts`
// asserts that every runtime value exported by ts-autocode-training and
// ts-autocode-rewrite is reachable from here. They had drifted, leaving
// README-documented symbols such as `trainingRounds` and `sequentialLoop`
// unreachable, and `defaultPromotionGates` -- needed to compose
// `TrainInput.gates` with the standard set -- unavailable.
export {
	candidateDeclaration,
	CandidateSyntaxError,
	conformanceAsyncTarget,
	conformanceCandidate,
	conformanceSuites,
	conformanceTarget,
	createCandidateReview,
	createEvalRun,
	createPromotionDecision,
	captureTrainable,
	configureTraining,
	createTrainingRuntime,
	defaultEvolution,
	defaultFanOut,
	defaultMaxRounds,
	defaultMinPassRate,
	defaultMinScore,
	defaultObjective,
	defaultOutputDir,
	defaultPromotionGates,
	defaultRetry,
	defaultTsconfig,
	defined,
	defineTrainable,
	directExecutor,
	discoverInSource,
	discoverTrainables,
	EngineContractError,
	EngineNotConfiguredError,
	EngineProposalError,
	evaluationArgs,
	evaluatePromotionGate,
	ExecutorNotConfiguredError,
	implementationExecutorContract,
	inMemoryArtifactRef,
	InsufficientTracesError,
	InvalidSettingsError,
	InvalidTrainableIdentityError,
	isTsAutocodeError,
	LoopCapabilityError,
	MemoryTrainingStore,
	MissingSecretError,
	OperationInterruptedError,
	optional,
	OperationTimeoutError,
	parseSetting,
	PromotionApplierNotConfiguredError,
	PromotionRejectedError,
	promotionApplierContract,
	promoterContract,
	provideTrainingDefaults,
	resetTraining,
	sequentialLoop,
	SourceDiscoveryError,
	toTrainableToken,
	trainableTokenFromSymbol,
	training,
	TraceNotFoundError,
	trainingEngineContract,
	trainingLoopContract,
	trainingMarker,
	trainingStoreContract,
	TrainingIncompleteError,
	trainingRounds,
	TsAutocodeError,
	TsAutocodeSyntaxError,
	TsAutocodeTypeError,
	withPolicy,
} from "ts-autocode-training";
export type {
	Activation,
	ActivationReadiness,
	AppliedPromotion,
	BoundEvaluation,
	ConfigureOptions,
	CandidatePatch,
	CandidateReview,
	CaptureSettings,
	EngineCandidate,
	EngineContext,
	ErrorPhase,
	EvalRunInput,
	EvolutionSettings,
	ExecutionSettings,
	ImplementationExecutor,
	Marker,
	ModelSelection,
	OptimizeRequest,
	PromotionApplier,
	Promoter,
	PromotionDecision,
	PromotionGate,
	PromotionGateContext,
	PromotionGateInput,
	PromotionSettings,
	ProposalTurn,
	ResiliencePolicy,
	ResilienceSettings,
	RetryOptions,
	ReviewContext,
	ReviewInput,
	RoundObserver,
	RoundSequence,
	RoundSettings,
	SecretProvider,
	SourceSettings,
	TrainInput,
	TrainableEvalRun,
	TrainableId,
	TrainableIdentity,
	TrainableTarget,
	TrainableToken,
	Training,
	TrainingEngine,
	TrainingEvent,
	TrainingLoop,
	TrainingLoopInput,
	TrainingLoopRun,
	TrainingProviders,
	TrainingRecord,
	TrainingRound,
	TrainingRun,
	TrainingSettings,
	TrainingStore,
	TracingSettings,
	TsAutocodeErrorCode,
} from "ts-autocode-training";

export {
	annotateRewrite,
	applyCandidate,
	check,
	commitRewrite,
	configureRewrite,
	createRewriter,
	declaringContainer,
	digest,
	dispatchRewrite,
	emitInstrumentation,
	installedInstrumentation,
	installInstrumentation,
	instrumentKey,
	restoreImplementation,
	revertRewrite,
	swapImplementation,
	swappedImplementation,
} from "ts-autocode-rewrite";
export type {
	AppliedRewrite,
	InstrumentEntry,
	InstrumentRegistry,
	InstrumentTarget,
	Instrumentation,
	RewriteCandidate,
	RewriteConfig,
	RewriteInterceptor,
	RewriteInvocation,
	RewriteSnapshot,
	RewriteTarget,
} from "ts-autocode-rewrite";

// `HarnessLoopOptions` is typed in terms of these, so configuring the default
// loop must not require taking a second, undocumented dependency.
export { defaultHarnessRounds } from "ts-autocode-harness";
export type {
	ContextProvider,
	JudgeDecision,
	JudgeRequest,
} from "ts-autocode-harness";
