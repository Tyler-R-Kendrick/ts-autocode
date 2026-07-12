export { check, digest, isNonEmptyString } from "./canonical.js";

export { installInstrumentation, installedInstrumentation, instrumentKey } from "./instrument.js";
export type { InstrumentEntry, InstrumentRegistry, InstrumentTarget, Instrumentation, Marker } from "./instrument.js";

export { createRewriter, emitInstrumentation } from "./emit.js";

export { applyCandidate } from "./apply.js";
export type { RewriteCandidate, RewriteTarget } from "./apply.js";

export { promoteCandidate, revertPromotion } from "./promotion.js";
export type { PromotionResult, PromotionSnapshot, RewriteApproval } from "./promotion.js";

export {
	Rewrite,
	annotateRewrite,
	configureRewrite,
	declaringContainer,
	dispatchRewrite,
	enableRewriteWeaving,
	hasRewriteMarker,
	normalizeMarker,
	restoreImplementation,
	rewriteMarkers,
	swapImplementation,
	swappedImplementation,
} from "./aspect.js";
export type { RewriteConfig, RewriteInterceptor, RewriteInvocation } from "./aspect.js";
