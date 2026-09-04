import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Stryker runs the suite once per surviving mutant, so it uses a narrowed
// config rather than the default one: only the tests that exercise the mutated
// modules, and no coverage (Stryker does its own instrumentation, and the
// thresholds would fail on every partial run).
//
// This is defined standalone rather than merged with vitest.config.ts, because
// mergeConfig concatenates `include` instead of replacing it, which silently
// ran the whole suite per mutant.
export default defineConfig({
	resolve: {
		alias: [
			{ find: /^ts-autocode$/, replacement: src("./src/index.ts") },
			{ find: /^ts-autocode\/ax$/, replacement: src("./src/providers/ax.ts") },
			{ find: /^ts-autocode\/internal$/, replacement: src("./src/internal.ts") },
			{ find: /^ts-autocode\/grounding$/, replacement: src("./src/grounding.ts") },
		],
	},
	test: {
		include: [
			"packages/training/test/promotion.test.ts",
			"packages/training/test/gates.test.ts",
			"packages/training/test/digest.test.ts",
			"packages/training/test/token.test.ts",
			"packages/training/test/optional.test.ts",
			"packages/training/test/builders.test.ts",
			"packages/rewrite/test/apply.test.ts",
			"packages/rewrite/test/canonical.test.ts",
			"packages/rewrite/test/instrument.test.ts",
			"packages/harness/test/harness.test.ts",
			"test/tier1.test.ts",
			"test/register.test.ts",
		],
	},
});
