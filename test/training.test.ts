import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import * as publicApi from "../src/index.js";
import {
	configureTraining,
	defineTrainable,
	trainable,
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
		applyMethodDecorator(Router, "route", trainable("Router.route"));

		expect(new Router().route("billing")).toBe("billing");
		expect(startActiveSpan).not.toHaveBeenCalled();
		expect(await training.records("Router.route")).toEqual([]);
	});

	it("supports the decorator without external source metadata", async () => {
		const training = configureTraining({});
		class Router {
			async fail(): Promise<void> {
				throw new Error("boom");
			}
		}
		applyMethodDecorator(Router, "fail", trainable("Router.fail"));

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
		applyMethodDecorator(RuntimeNormalizer, "normalize", trainable("liveNormalize"));
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

	it("requires enough successful runtime traces before evolving code", async () => {
		const training = configureTraining({ tracing: { enabled: false } });
		class Router {
			route(input: string): string { return input; }
		}
		applyMethodDecorator(Router, "route", trainable("Router.live"));
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
