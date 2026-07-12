export { check, digest } from "./canonical.js";

export { installInstrumentation, installedInstrumentation, instrumentKey } from "./instrument.js";
export type { InstrumentEntry, InstrumentRegistry, InstrumentTarget, Instrumentation, Marker } from "./instrument.js";

export { createRewriter, emitInstrumentation } from "./emit.js";

export { applyCandidate, commitRewrite, revertRewrite } from "./apply.js";
export type { AppliedRewrite, RewriteCandidate, RewriteSnapshot, RewriteTarget } from "./apply.js";

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
