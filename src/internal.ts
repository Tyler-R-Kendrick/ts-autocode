
export {
	candidateDeclaration,
	captureTrainable,
	provideTrainingDefaults,
	withPolicy,
} from "ts-autocode-training";
export type {
	BoundEvaluation,
	CandidatePatch,
	CandidateReview,
	EngineCandidate,
	EngineContext,
	ImplementationExecutor,
	OptimizeRequest,
	PromotionApplier,
	ProposalTurn,
	ReviewContext,
	SecretProvider,
	TrainableTarget,
	TrainingEngine,
	TrainingLoop,
	TrainingLoopInput,
	TrainingLoopRun,
	TrainingProviders,
	TrainingRound,
	TrainingStore,
} from "ts-autocode-training";

export {
	annotateRewrite,
	applyCandidate,
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

export { configureRewriteCapture, rewritePromotion } from "./providers/rewrite.js";
export { instrumentTrainable, wrapTrainable } from "./instrumentation.js";
