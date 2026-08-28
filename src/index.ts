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
	captureTrainable,
	configureTraining,
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
	defineTrainable,
	discoverInSource,
	discoverTrainables,
	evaluatePromotionGate,
	inMemoryArtifactRef,
	MemoryTrainingStore,
	OperationTimeoutError,
	provideTrainingDefaults,
	sequentialLoop,
	trainableTokenFromSymbol,
	training,
	trainingMarker,
	trainingRounds,
	withPolicy,
} from "ts-autocode-training";
export type {
	Activation,
	AppliedPromotion,
	BoundEvaluation,
	CandidatePatch,
	CandidateReview,
	CaptureSettings,
	EngineCandidate,
	EngineContext,
	ErrorPhase,
	EvolutionSettings,
	ExecutionSettings,
	ImplementationExecutor,
	Marker,
	OptimizeRequest,
	PromotionApplier,
	PromotionDecision,
	PromotionGate,
	PromotionGateContext,
	PromotionGateInput,
	ProposalTurn,
	ResiliencePolicy,
	ResilienceSettings,
	RetryOptions,
	ReviewContext,
	RoundObserver,
	RoundSequence,
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
export type {
	ContextProvider,
	JudgeDecision,
	JudgeRequest,
} from "ts-autocode-harness";
