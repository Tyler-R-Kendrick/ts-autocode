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

import { provideTrainingDefaults } from "../src/index.js";

/** Wires ts-autocode-rewrite into training's weaver and promoter ports the same
 * way the main ts-autocode package does. The sibling is a devDependency only:
 * the runtime under test never imports it, while these tests still exercise the
 * genuine weaving and guarded promotion. */
provideTrainingDefaults({
	weaver: {
		configure: configureRewrite,
		annotate: annotateRewrite,
		dispatch: dispatchRewrite,
		declaringContainer,
		swap: swapImplementation,
		restore: restoreImplementation,
	},
	promoter: { promote: promoteCandidate, revert: revertPromotion },
});
