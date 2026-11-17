import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
	createTrainingRuntime,
	defineTrainable,
	MissingSecretError,
} from "../src/index.js";


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

			expect(await runtime.records(defineTrainable("zeroConfigEcho"))).toEqual([]);

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
