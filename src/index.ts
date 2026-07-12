import { provideTrainingDefaults } from "ts-autocode-training";

import { executeImplementation } from "./execution.js";
import { createAxEngine } from "./providers/ax.js";

provideTrainingDefaults({ engine: () => createAxEngine(), executor: executeImplementation });

export {
	applyCandidate,
	configureTraining,
	createMemoryTrainingStore,
	defineTrainable,
	discoverTrainables,
	evaluatePromotionGate,
	promoteCandidate,
	revertPromotion,
	trainable,
	training,
} from "ts-autocode-training";
export type {
	BoundEvaluation,
	CandidateEvalConfig,
	CandidatePatch,
	CaptureSettings,
	EngineCandidate,
	EngineContext,
	EvolveInput,
	EvolveResult,
	ImplementationExecutor,
	OptimizeInput,
	OptimizeRequest,
	PromotionDecision,
	PromotionGateInput,
	PromotionResult,
	PromotionSnapshot,
	SecretProvider,
	SourceSettings,
	TrainInput,
	TrainableId,
	TrainableIdentity,
	TrainableTarget,
	TrainableToken,
	Training,
	TrainingEngine,
	TrainingRecord,
	TrainingRound,
	TrainingRun,
	TrainingSettings,
	TrainingStore,
	TracingSettings,
} from "ts-autocode-training";
