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

export { createHarnessLoop, defaultActionLogFile } from "./providers/harness.js";
export type { HarnessLoopOptions } from "./providers/harness.js";
export { configureRewriteCapture, rewritePromotion } from "./providers/rewrite.js";
export { instrumentTrainable, trainable, wrapTrainable } from "./instrumentation.js";
export type { TrainableDecorator } from "./instrumentation.js";

export {
	captureTrainable,
	configureTraining,
	createMemoryTrainingStore,
	defaultEvolution,
	defaultObjective,
	defaultOutputDir,
	defaultTsconfig,
	defineTrainable,
	discoverTrainables,
	evaluatePromotionGate,
	provideTrainingDefaults,
	training,
	trainingMarker,
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
	EvolutionSettings,
	ImplementationExecutor,
	OptimizeRequest,
	PromotionApplier,
	PromotionDecision,
	PromotionGate,
	PromotionGateContext,
	PromotionGateInput,
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
	applyCandidate,
	commitRewrite,
	restoreImplementation,
	revertRewrite,
	swapImplementation,
} from "ts-autocode-rewrite";
export type { AppliedRewrite, RewriteCandidate, RewriteSnapshot, RewriteTarget } from "ts-autocode-rewrite";
