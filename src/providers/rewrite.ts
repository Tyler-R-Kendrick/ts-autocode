import {
	annotateRewrite,
	configureRewrite,
	declaringContainer,
	dispatchRewrite,
	promoteCandidate,
	restoreImplementation,
	revertPromotion,
	swapImplementation,
} from "ts-autocode-rewrite";
import type { MethodWeaver, SourcePromoter } from "ts-autocode-training";

/** The sibling packages never import each other; this package owns the wiring.
 * ts-autocode-rewrite satisfies training's ports structurally. */
export const rewriteWeaver: MethodWeaver = {
	configure: configureRewrite,
	annotate: annotateRewrite,
	dispatch: dispatchRewrite,
	declaringContainer,
	swap: swapImplementation,
	restore: restoreImplementation,
};

export const sourcePromoter: SourcePromoter = {
	promote: promoteCandidate,
	revert: revertPromotion,
};
