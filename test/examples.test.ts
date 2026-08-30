import { describe, expect, it } from "vitest";

import { optimizeRouter } from "../examples/optimize.js";
import type { TrainingEngine } from "../src/index.js";

// examples/optimize.ts imported "../src/index.js" rather than the package name,
// exported a function rather than running, and was referenced by no test or
// script -- so nothing would have noticed it breaking. CONTRIBUTING asks for a
// runnable example; this executes it on every check.

const engine: TrainingEngine = {
	id: "examples-test",
	optimize: async () => ({ implementation: 'return input.includes("invoice") ? "billing" : "fallback";' }),
};

describe("examples/optimize.ts", () => {
	it("runs end to end against a stub engine", async () => {
		const run = await optimizeRouter(engine);
		expect(run.outcome).toBe("ready");
		expect(run.canActivate()).toEqual({ ready: true });
		expect(run.final.candidate.trainableId).toBe("Router.route");
	}, 30_000);
});
