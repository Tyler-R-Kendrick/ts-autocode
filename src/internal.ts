// Author-level API: the seams for building an engine, a loop, an executor, a
// store, or an instrumentation mechanism -- not for using the library.
//
// CONTRIBUTING asks that the root export surface stay small and that internal
// helpers stay internal. These are neither internal nor application-facing:
// they are the extension points, and they belong on their own subpath so
// `import { ... } from "ts-autocode"` offers a consumer only what a consumer
// needs. Everything here is still exported from the root for compatibility.

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
