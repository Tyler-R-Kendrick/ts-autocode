import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts", "packages/harness/test/**/*.test.ts", "packages/training/test/**/*.test.ts"],
	},
});
