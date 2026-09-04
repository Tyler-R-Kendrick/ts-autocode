import { describe, expect, it } from "vitest";

import {
	configureTraining,
	defineTrainable,
	instrumentTrainable,
	restoreImplementation,
	swapImplementation,
	toTrainableToken,
	trainable,
	training,
	wrapTrainable,
} from "../src/index.js";

describe("instrumentation wiring", () => {
	it("infers the decorator identity from the decorated class and method", async () => {
		configureTraining({ tracing: { enabled: false } });
		class InferredRouter {
			route(input: string): string { return input; }
		}
		applyMethodDecorator(InferredRouter, "route", trainable());

		expect(new InferredRouter().route("billing")).toBe("billing");
		// The auto-generated symbol is recreatable, so tests can target the trainable.
		const [record] = await training.records(defineTrainable("InferredRouter.route").symbol);
		expect(record?.trainableId).toBe("InferredRouter.route");
		expect(record?.succeeded).toBe(true);
	});

	it("rejects non-symbol decorator identities", () => {
		expect(() => trainable("Router.route" as never)).toThrow("must be a symbol");
	});

	it("instruments classes in place for capture without the decorator", async () => {
		configureTraining({ tracing: { enabled: false } });
		class Plain {
			route(input: string): string { return input; }
		}
		instrumentTrainable(Plain, "route", "Plain.route");
		instrumentTrainable(Plain, "route", "Plain.route");

		expect(new Plain().route("billing")).toBe("billing");
		const records = await training.records(defineTrainable("Plain.route"));
		expect(records).toHaveLength(1);
		expect(records[0]?.trainableId).toBe("Plain.route");
	});
});

describe("wrapping a directive-marked free function", () => {
	// `wrapTrainable` is the load-time half of the zero-config flow: what
	// `ts-autocode/register` calls for a `"use training"` function rather than a
	// class method. Every test of that flow installs a stub `wrap` handler, so
	// the real wrapper was built but never called: the capture, the identity
	// stamp and the hot-swap it exists to route through were all unexercised.

	it("returns what the function returns, and captures the call", async () => {
		configureTraining({ tracing: { enabled: false } });
		const wrapped = wrapTrainable((input: string) => input.toUpperCase(), "Free.shout");

		expect(wrapped("billing")).toBe("BILLING");
		const records = await training.records(defineTrainable("Free.shout"));
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ trainableId: "Free.shout", succeeded: true });
	});

	it("lets a failure through unchanged, and records it as a failure", async () => {
		configureTraining({ tracing: { enabled: false } });
		const wrapped = wrapTrainable(() => { throw new Error("boom"); }, "Free.fails");

		expect(() => wrapped()).toThrow("boom");
		expect(await training.records(defineTrainable("Free.fails"))).toMatchObject([{ succeeded: false }]);
	});

	it("is idempotent: wrapping an already-wrapped function hands back the same one", () => {
		const wrapped = wrapTrainable((input: string) => input, "Free.once");
		expect(wrapTrainable(wrapped, "Free.once")).toBe(wrapped);
	});

	it("keeps the function's own name, falling back to the id for an anonymous one", () => {
		function named(input: string): string { return input; }
		expect(wrapTrainable(named, "Free.named").name).toBe("named");
		expect(wrapTrainable(((input: string) => input) as { (input: string): string; name?: string }, "Free.arrow").name)
			.toBe("Free.arrow");
	});

	it("stamps the wrapper with its identity, so train() resolves it without a retyped string", () => {
		const wrapped = wrapTrainable((input: string) => input, "Free.stamped");
		expect(toTrainableToken(wrapped).id).toBe("Free.stamped");
	});

	it("routes through a hot-swapped implementation once one is promoted", () => {
		const wrapped = wrapTrainable((input: string) => input, "Free.swappable");
		expect(wrapped("a")).toBe("a");

		swapImplementation("Free.swappable", (input) => `swapped:${String(input)}`);
		try {
			expect(wrapped("a")).toBe("swapped:a");
		} finally {
			restoreImplementation("Free.swappable");
		}
		expect(wrapped("a")).toBe("a");
	});
});

function applyMethodDecorator<Class extends abstract new (...args: never[]) => object>(
	constructor: Class,
	name: string,
	decorator: ReturnType<typeof trainable>,
): void {
	const prototype = constructor.prototype as Record<string, unknown>;
	const method = prototype[name] as (...args: unknown[]) => unknown;
	const initializers: Array<(this: object) => void> = [];
	const replacement = decorator(method, {
		kind: "method",
		name,
		static: false,
		private: false,
		access: {
			has: (value: unknown) => name in (value as object),
			get: (value: unknown) => (value as Record<string, unknown>)[name] as (...args: unknown[]) => unknown,
		},
		addInitializer(initializer: (this: object) => void) {
			initializers.push(initializer);
		},
		metadata: undefined,
	} as unknown as ClassMethodDecoratorContext);
	Object.defineProperty(prototype, name, { value: replacement, configurable: true, writable: true });
	for (const initializer of initializers) initializer.call(Object.create(constructor.prototype) as object);
}
