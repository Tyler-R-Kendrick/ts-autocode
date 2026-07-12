import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import * as publicApi from "../src/index.js";
import {
	configureTraining,
	defineTrainable,
	trainable,
	training as defaultTraining,
	type TrainingEngine,
} from "../src/index.js";
import { discoverInSource } from "../src/source.js";

const source = `class Router {
  route(input: string): string {
    "use training";
    return input;
  }
}`;
const target = discoverInSource(source, "src/router.ts")[0]!;

describe("trainable identity", () => {
	it("marks methods with only the directive and exposes no wrapper API", () => {
		class Router {
			route(input: string): string {
				"use training";
				return input.toUpperCase();
			}
		}

		expect(new Router().route("billing")).toBe("BILLING");
		expect("useTraining" in publicApi).toBe(false);
		expect("createTraining" in publicApi).toBe(false);
		expect("default" in publicApi).toBe(false);
	});

	it("uses a durable id and stable symbol", () => {
		const first = defineTrainable("Router.route");
		const second = defineTrainable("Router.route");
		expect(first.symbol).toBe(second.symbol);
	});

	it("infers the decorator identity from the decorated class and method", async () => {
		configureTraining({ tracing: { enabled: false } });
		class InferredRouter {
			route(input: string): string { return input; }
		}
		applyMethodDecorator(InferredRouter, "route", trainable());

		expect(new InferredRouter().route("billing")).toBe("billing");
		const [record] = await defaultTraining.records("InferredRouter.route");
		expect(record?.trainableId).toBe("InferredRouter.route");
		expect(record?.succeeded).toBe(true);
	});

	it("rejects non-symbol decorator identities", () => {
		expect(() => trainable("Router.route" as never)).toThrow("must be a symbol");
	});
});

describe("trainable method capture", () => {
	it("controls capture and tracing only through global settings", async () => {
		const startActiveSpan = vi.fn();
		const training = configureTraining({
			capture: { enabled: false },
			tracing: { enabled: false, tracer: { startActiveSpan } as never },
		});
		class Router {
			route(input: string): string { return input; }
		}
		applyMethodDecorator(Router, "route", trainable());

		expect(new Router().route("billing")).toBe("billing");
		expect(startActiveSpan).not.toHaveBeenCalled();
		expect(await training.records("Router.route")).toEqual([]);
	});

	it("lets capture mappers redact values to undefined", async () => {
		const training = configureTraining({
			tracing: { enabled: false },
			capture: { mapInput: () => undefined, mapOutput: () => undefined },
		});
		class Router {
			route(input: string): string { return input; }
		}
		applyMethodDecorator(Router, "route", trainable(defineTrainable("Router.redacted").symbol));

		expect(new Router().route("secret-input")).toBe("secret-input");
		const [record] = await training.records("Router.redacted");
		expect(record?.succeeded).toBe(true);
		expect(JSON.stringify(record)).not.toContain("secret-input");
	});

	it("supports the decorator without external source metadata", async () => {
		const training = configureTraining({});
		class Router {
			async fail(): Promise<void> {
				throw new Error("boom");
			}
		}
		applyMethodDecorator(Router, "fail", trainable());

		await expect(new Router().fail()).rejects.toThrow("boom");
		const [record] = await training.records("Router.fail");
		expect(record?.succeeded).toBe(false);
		expect(record?.trace.errorCount).toBe(1);
	});
});

describe("training execution", () => {
	it("parallelizes independent trainables with a configured cap", async () => {
		let active = 0;
		let maxActive = 0;
		const engine: TrainingEngine = {
			id: "parallel",
			async optimize() {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 10));
				active -= 1;
				return { implementation: "return input;" };
			},
		};
		const training = configureTraining({ engine, concurrency: 2 });

		await training.optimizeAll(["one", "two"].map((objective) => ({
			trainable: "Router.route",
			objective,
			target,
		})));
		expect(maxActive).toBe(2);
	});

	it("evolves source from successful live traces and AgentV evals", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ts-autocode-live-"));
		const artifact = join(directory, "normalize.ts");
		await writeFile(artifact, `export function liveNormalize(input: string): string {
  "use training";
  return input;
}\n`);
		const optimize = vi.fn<TrainingEngine["optimize"]>(async (request) => {
			expect(request.records).toHaveLength(2);
			expect(request.evaluations).toHaveLength(2);
			return { implementation: "return input.toUpperCase();" };
		});
		const training = configureTraining({
			engine: { id: "live-test", optimize },
			source: { files: [artifact] },
			tracing: { enabled: false },
		});
		class RuntimeNormalizer {
			normalize(input: string): string { return input.toUpperCase(); }
		}
		applyMethodDecorator(RuntimeNormalizer, "normalize", trainable(defineTrainable("liveNormalize").symbol));
		const normalize = new RuntimeNormalizer();
		normalize.normalize("alpha");
		normalize.normalize("beta");

		const result = await training.evolve({
			trainable: "liveNormalize",
			objective: "Preserve behavior observed in live traces",
			minTraces: 2,
			evaluation: { workers: 2, outputDir: join(directory, "agentv") },
		});

		expect(result.training.outcome).toBe("ready");
		expect(result.training.baseline.run.summary.passed).toBe(2);
		expect(result.training.final.verification.run.summary.passed).toBe(2);
		expect(result.promotion.source).toContain("return input.toUpperCase();");
		expect(await readFile(artifact, "utf8")).toContain("return input.toUpperCase();");
		expect(await readFile(artifact, "utf8")).toContain('"use training"');
	});

	it("waives the conformance requirement instead of rejecting every candidate", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ts-autocode-conformance-"));
		const artifact = join(directory, "echo.ts");
		await writeFile(artifact, `export function echo(input: string): string {
  "use training";
  return input;
}\n`);
		const training = configureTraining({
			engine: { id: "conformance-test", optimize: async () => ({ implementation: "return input.toUpperCase();" }) },
			source: { files: [artifact] },
			tracing: { enabled: false },
		});

		const run = await training.train({
			trainable: "echo",
			objective: "Uppercase the input",
			conformance: false,
			evaluation: {
				tests: [{ id: "upper", input: "abc", assert: [{ type: "equals", value: "ABC" }] }],
				task: (input) => input,
				outputDir: join(directory, "agentv"),
			},
		});

		expect(run.outcome).toBe("ready");
		expect(run.final.decision.failures).toEqual([]);
	});

	it("requires enough successful runtime traces before evolving code", async () => {
		const training = configureTraining({ tracing: { enabled: false } });
		class Router {
			route(input: string): string { return input; }
		}
		applyMethodDecorator(Router, "route", trainable(defineTrainable("Router.live").symbol));
		new Router().route("one");

		await expect(training.evolve({
			trainable: "Router.live",
			objective: "Improve routing",
			minTraces: 2,
		})).rejects.toThrow("requires 2 distinct successful runtime traces; found 1");
	});
});

function applyMethodDecorator<Class extends abstract new (...args: never[]) => object>(
	constructor: Class,
	name: string,
	decorator: ReturnType<typeof trainable>,
): void {
	const prototype = constructor.prototype as Record<string, unknown>;
	const method = prototype[name] as (...args: unknown[]) => unknown;
	const replacement = decorator(method, {
		kind: "method",
		name,
		static: false,
		private: false,
		access: {
			has: (value: unknown) => name in (value as object),
			get: (value: unknown) => (value as Record<string, unknown>)[name] as (...args: unknown[]) => unknown,
		},
		addInitializer() {},
		metadata: undefined,
	} as unknown as ClassMethodDecoratorContext);
	Object.defineProperty(prototype, name, { value: replacement, configurable: true, writable: true });
}
