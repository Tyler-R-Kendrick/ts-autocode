import { provideTrainingDefaults } from "ts-autocode-training";

import { executeImplementation } from "./execution.js";
import { createAxEngine } from "./providers/ax.js";
import { createHarnessLoop } from "./providers/harness.js";

// This package connects the provider-neutral training runtime to its concrete
// providers: Ax optimizes and executes candidates, and the governed agent
// harness drives training rounds.
provideTrainingDefaults({
	engine: () => createAxEngine(),
	executor: executeImplementation,
	loop: createHarnessLoop(),
});

export { createHarnessLoop } from "./providers/harness.js";

export {
	configureTraining,
	createMemoryTrainingStore,
	defineTrainable,
	discoverTrainables,
	evaluatePromotionGate,
	trainable,
	training,
} from "ts-autocode-training";
export type {
	BoundEvaluation,
	CandidateEvalConfig,
	CandidatePatch,
	CandidateReview,
	CaptureSettings,
	EngineCandidate,
	EngineContext,
	EvolutionSettings,
	EvolveResult,
	ImplementationExecutor,
	OptimizeRequest,
	PromotionDecision,
	PromotionGateInput,
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
