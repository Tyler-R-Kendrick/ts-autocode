import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
	createTrainingRuntime,
	defineTrainable,
	MissingSecretError,
} from "../src/index.js";

// The rule this suite states: every injected seam ships a default, so
// zero-config lacks exactly one thing -- a credential. A seam without a
// default is configuration a user is responsible for, which is the situation
// the provider-neutral design exists to avoid. If a future change unwires a
// default, the error below stops being MissingSecretError and becomes the
// seam's own NotConfigured error, and this test names the regression.

describe("every seam has a default", () => {
	it("a zero-config runtime fails only for the missing credential", async () => {
		vi.stubEnv("OPENAI_API_KEY", "");
		vi.stubEnv("OPENAI_APIKEY", "");
		try {
			const directory = await mkdtemp(join(tmpdir(), "ts-autocode-defaults-"));
			const artifact = join(directory, "echo.ts");
			await writeFile(artifact, `export function zeroConfigEcho(input: string): string {
  "use training";
  return input;
}\n`);
			const runtime = createTrainingRuntime({
				source: { files: [artifact] },
				tracing: { enabled: false },
			});

			// The store default works without configuration.
			expect(await runtime.records(defineTrainable("zeroConfigEcho"))).toEqual([]);

			// Training reaches the default engine and stops at its credential --
			// not at EngineNotConfiguredError, ExecutorNotConfiguredError, or
			// PromotionApplierNotConfiguredError, each of which would mean a seam
			// no longer has a default.
			await expect(runtime.train({
				trainable: defineTrainable("zeroConfigEcho").symbol,
				evaluation: {
					tests: [{ id: "echo", input: "abc", assert: [{ type: "equals", value: "abc" }] }],
					task: (input: string) => input,
					outputDir: join(directory, "agentv"),
				},
				rounds: { max: 1 },
			})).rejects.toThrow(MissingSecretError);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
