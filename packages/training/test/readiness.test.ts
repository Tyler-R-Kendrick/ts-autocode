import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Deliberately no `./wiring.js` import: this file exercises the runtime with
// NO process-wide promotion applier registered, which is exactly the state
// canActivate() lied about -- it reported ready and activate() then threw
// PromotionApplierNotConfiguredError anyway.
import {
	createTrainingRuntime,
	defineTrainable,
	directExecutor,
	PromotionApplierNotConfiguredError,
	type Promoter,
} from "../src/index.js";

describe("activation readiness without an applier", () => {
	async function trainedRun(promote?: Promoter) {
		const directory = await mkdtemp(join(tmpdir(), "ts-autocode-readiness-"));
		const artifact = join(directory, "echo.ts");
		await writeFile(artifact, `export function readinessEcho(input: string): string {
  "use training";
  return input;
}\n`);
		const runtime = createTrainingRuntime({
			engine: () => "return input;",
			executor: directExecutor,
			source: { files: [artifact] },
			tracing: { enabled: false },
			...(promote === undefined ? {} : { promote }),
		});
		return runtime.train(defineTrainable("readinessEcho"), {
			cases: [["a", "a"]],
			evaluation: { outputDir: join(directory, "agentv") },
			rounds: { max: 1 },
		});
	}

	it("canActivate agrees with activate: not ready, and activate throws the same fact", async () => {
		const run = await trainedRun();
		const readiness = run.canActivate();
		expect(readiness.ready).toBe(false);
		if (!readiness.ready) {
			expect(readiness.failures.join(" ")).toContain(new PromotionApplierNotConfiguredError().message);
		}
		await expect(run.activate()).rejects.toThrow(PromotionApplierNotConfiguredError);
	});

	it("a runtime-supplied applier restores readiness", async () => {
		const run = await trainedRun(async () => ({ rollback: async () => {} }));
		expect(run.canActivate()).toEqual({ ready: true });
		await expect(run.activate()).resolves.toBeDefined();
	});
});
