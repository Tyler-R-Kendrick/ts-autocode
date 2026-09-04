import { describe, expect, it } from "vitest";

import { applyCandidate } from "ts-autocode-rewrite";

import {
	defineTrainable,
	type CandidatePatch,
	type TrainingEngine,
	type TrainingRecord,
} from "../src/index.js";
import { CandidateEngine } from "../src/engine.js";
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
	it("composes the strategy and wraps a minimal engine result as a candidate", async () => {
		const engine: TrainingEngine = {
			id: "test-engine",
			async optimize(request, context) {
				expect(request.target.signature).toBe("route(input: string): string");
				expect(context.variables["MODEL"]).toBe("test-model");
				expect(await context.secrets?.get("API_KEY")).toBe("secret");
				return { implementation: "return input.toUpperCase();" };
			},
		};

		const candidate = await new CandidateEngine(engine).propose(
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
		expect(() => applyCandidate(changed, candidate)).toThrow("changed after discovery");
	});

	// `#validateRequest` is what keeps one trainable's evidence out of another's
	// optimization. A request assembled with the wrong records trains a method
	// on traffic it never served, and the resulting candidate is scored against
	// the wrong behavior -- so these guards fail the request rather than
	// proposing from it. Only the objective guard was covered.
	describe("request validation", () => {
		const engine: TrainingEngine = { id: "guard", async optimize() { return { implementation: "return input;" }; } };
		const other = defineTrainable("Other.route");

		function request(overrides: Partial<Parameters<CandidateEngine["propose"]>[0]> = {}) {
			return {
				trainableId: token.id,
				objective: "uppercase",
				target,
				records: [],
				evaluations: [],
				...overrides,
			};
		}

		function record(trainableId: TrainingRecord["trainableId"]): TrainingRecord {
			return {
				id: "r1",
				runId: "run-1",
				trainableId,
				method: "route",
				succeeded: true,
				recordedAt: new Date(0).toISOString(),
				trace: { messages: [] } as unknown as TrainingRecord["trace"],
			};
		}

		it.each([
			["empty", ""],
			["only whitespace", "  \t "],
		])("refuses an objective that is %s", async (_label, objective) => {
			await expect(new CandidateEngine(engine).propose(request({ objective }), { variables: {} }))
				.rejects.toThrow("optimization objective must be a non-empty string");
		});

		it("refuses a target that is not the trainable the request names", async () => {
			await expect(new CandidateEngine(engine).propose(
				request({ trainableId: other.id }),
				{ variables: {} },
			)).rejects.toThrow("trainable target must match the request id");
		});

		it("refuses records captured from a different trainable", async () => {
			await expect(new CandidateEngine(engine).propose(
				request({ records: [record(token.id), record(other.id)] }),
				{ variables: {} },
			)).rejects.toThrow("training records must match the request id");
		});

		it("refuses evaluations bound to a different trainable", async () => {
			await expect(new CandidateEngine(engine).propose(
				request({ evaluations: [{ trainableId: other.id, result: {} as never }] }),
				{ variables: {} },
			)).rejects.toThrow("evaluations must match the request id");
		});

		it("accepts records and evaluations that all name the request's trainable", async () => {
			await expect(new CandidateEngine(engine).propose(
				request({
					records: [record(token.id)],
					evaluations: [{ trainableId: token.id, result: {} as never }],
				}),
				{ variables: {} },
			)).resolves.toMatchObject({ trainableId: token.id });
		});

		it("refuses an engine whose own id is blank, before it is ever asked", () => {
			expect(() => new CandidateEngine({ ...engine, id: "  " })).toThrow();
		});
	});

	it("rejects invalid TypeScript returned by an engine", async () => {
		const engine: TrainingEngine = {
			id: "invalid",
			async optimize() { return { implementation: "return (" }; },
		};
		await expect(new CandidateEngine(engine).propose(
			{ trainableId: token.id, objective: "break it", target, records: [], evaluations: [] },
			{ variables: {} },
		)).rejects.toThrow("invalid TypeScript");
	});
});
