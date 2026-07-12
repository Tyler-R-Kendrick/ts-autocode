export { digest, isNonEmptyString } from "./canonical.js";

export { applyCandidate } from "./apply.js";
export type { RewriteCandidate, RewriteTarget } from "./apply.js";

export { promoteCandidate, revertPromotion } from "./promotion.js";
export type { PromotionResult, PromotionSnapshot, RewriteApproval } from "./promotion.js";

export {
	Trainable,
	annotateTrainable,
	dispatchTrainable,
	enableTrainableWeaving,
	restoreImplementation,
	setTrainableInterceptor,
	swapImplementation,
	swappedImplementation,
} from "./aspect.js";
export type { TrainableInterceptor, TrainableInvocation } from "./aspect.js";
