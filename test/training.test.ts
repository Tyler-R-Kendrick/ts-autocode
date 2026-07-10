import { describe, expect, it } from "vitest";

import * as publicApi from "../src/index.js";
import {
	createTraining,
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
		expect("default" in publicApi).toBe(false);
	});

	it("uses a durable id and stable symbol", () => {
		const first = defineTrainable("Router.route");
		const second = defineTrainable("Router.route");
		expect(first.symbol).toBe(second.symbol);
	});
});

describe("trainable method capture", () => {
	it("supports the decorator without external source metadata", async () => {
		const training = createTraining({});
		class Router {
			async fail(): Promise<void> {
				throw new Error("boom");
			}
		}
		applyMethodDecorator(Router, "fail", trainable("Router.fail", { training }));

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
		const training = createTraining({ engine, concurrency: 2 });

		await training.optimizeAll(["one", "two"].map((objective) => ({
			trainable: "Router.route",
			objective,
			target,
		})));
		expect(maxActive).toBe(2);
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
