import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
	resolve: {
		// `examples/` imports by package name, as a consumer would, but the
		// package's own entry points at `dist/`, which `npm run check` does not
		// build until after the tests run. Vitest also does not read
		// tsconfig `paths`, so mirror them here: without this the example
		// resolves only when a stale `dist/` happens to be lying around.
		alias: [
			{ find: /^ts-autocode$/, replacement: src("./src/index.ts") },
			{ find: /^ts-autocode\/ax$/, replacement: src("./src/providers/ax.ts") },
			{ find: /^ts-autocode\/internal$/, replacement: src("./src/internal.ts") },
			{ find: /^ts-autocode\/grounding$/, replacement: src("./src/grounding.ts") },
		],
	},
	test: {
		include: ["test/**/*.test.ts", "packages/grounding/test/**/*.test.ts", "packages/harness/test/**/*.test.ts", "packages/rewrite/test/**/*.test.ts", "packages/training/test/**/*.test.ts"],
	},
});
