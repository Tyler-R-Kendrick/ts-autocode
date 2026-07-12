import { provideTrainingDefaults } from "ts-autocode-training";

import { executeImplementation } from "./execution.js";
import { createAxEngine } from "./providers/ax.js";
import { createHarnessLoop } from "./providers/harness.js";
import { rewriteWeaver, sourcePromoter } from "./providers/rewrite.js";

// This package connects the provider-neutral training runtime to its concrete
// providers: Ax optimizes and executes candidates, the governed agent harness
// drives training rounds, and the rewrite package weaves and promotes. The
// sibling packages never import each other; they meet only here.
provideTrainingDefaults({
	engine: () => createAxEngine(),
	executor: executeImplementation,
	loop: createHarnessLoop(),
	weaver: rewriteWeaver,
	promoter: sourcePromoter,
});

export { createHarnessLoop, defaultActionLogFile } from "./providers/harness.js";
export type { HarnessLoopOptions } from "./providers/harness.js";
export { rewriteWeaver, sourcePromoter } from "./providers/rewrite.js";

export {
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
	trainable,
	training,
	trainingMarker,
} from "ts-autocode-training";
export type {
	Activation,
	BoundEvaluation,
	CandidatePatch,
	CandidateReview,
	CaptureSettings,
	EngineCandidate,
	EngineContext,
	EvolutionSettings,
	ImplementationExecutor,
	MethodWeaver,
	OptimizeRequest,
	PromotionDecision,
	PromotionGateInput,
	SecretProvider,
	SourcePromoter,
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
	promoteCandidate,
	restoreImplementation,
	revertPromotion,
	swapImplementation,
} from "ts-autocode-rewrite";
export type { PromotionResult, PromotionSnapshot } from "ts-autocode-rewrite";
