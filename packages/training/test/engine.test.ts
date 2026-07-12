import { describe, expect, it } from "vitest";

import { applyCandidate } from "ts-autocode-rewrite";

import {
	defineTrainable,
	type CandidatePatch,
	type TrainingEngine,
} from "../src/index.js";
import { optimizeCandidate } from "../src/engine.js";
import { discoverInSource } from "../src/source.js";

const source = `class Router {
  route(input: string): string {
    "use training";
    return input;
  }
}`;
const token = defineTrainable("Router.route");
const target = discoverInSource(source, "src/router.ts")[0]!;

describe("provider-neutral engine", () => {
	it("passes settings and wraps a minimal engine result as a candidate", async () => {
		const engine: TrainingEngine = {
			id: "test-engine",
			async optimize(request, context) {
				expect(request.target.signature).toBe("route(input: string): string");
				expect(context.variables["MODEL"]).toBe("test-model");
				expect(await context.secrets?.get("API_KEY")).toBe("secret");
				return { implementation: "return input.toUpperCase();" };
			},
		};

		const candidate = await optimizeCandidate(
			engine,
			{ trainableId: token.id, objective: "uppercase", target, records: [], evaluations: [] },
			{
				variables: { MODEL: "test-model" },
				secrets: { async get() { return "secret"; } },
			},
		);

		expect(candidate).toMatchObject({ trainableId: token.id, engineId: "test-engine", target });
		expect(applyCandidate(source, candidate)).toContain("return input.toUpperCase();");
		expect(source).toContain("return input;");
	});

	it("refuses to overwrite a method that changed after discovery", () => {
		const candidate: CandidatePatch = {
			id: "candidate",
			trainableId: token.id,
			engineId: "test",
			target,
			implementation: "return input.toUpperCase();",
		};
		const changed = source.replace("return input;", "return input.trim();");
		expect(() => applyCandidate(changed, candidate)).toThrow("changed after optimization started");
	});

	it("rejects invalid TypeScript returned by an engine", async () => {
		const engine: TrainingEngine = {
			id: "invalid",
			async optimize() { return { implementation: "return (" }; },
		};
		await expect(optimizeCandidate(
			engine,
			{ trainableId: token.id, objective: "break it", target, records: [], evaluations: [] },
			{ variables: {} },
		)).rejects.toThrow("invalid TypeScript");
	});
});
