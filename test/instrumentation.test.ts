import { describe, expect, it } from "vitest";

import {
	configureTraining,
	defineTrainable,
	instrumentTrainable,
	trainable,
	training,
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
