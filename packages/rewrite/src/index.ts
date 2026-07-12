export { digest } from "./canonical.js";

export { applyCandidate } from "./apply.js";
export type { RewriteCandidate, RewriteTarget } from "./apply.js";

export { promoteCandidate, revertPromotion } from "./promotion.js";
export type { PromotionResult, PromotionSnapshot, RewriteApproval } from "./promotion.js";

export {
	annotateRewrite,
	configureRewrite,
	declaringContainer,
	dispatchRewrite,
	restoreImplementation,
	swapImplementation,
	swappedImplementation,
} from "./aspect.js";
export type { RewriteConfig, RewriteInterceptor, RewriteInvocation } from "./aspect.js";
