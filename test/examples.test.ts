import { describe, expect, it } from "vitest";

import { optimizeRouter } from "../examples/optimize.js";
import type { TrainingEngine } from "../src/index.js";


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
