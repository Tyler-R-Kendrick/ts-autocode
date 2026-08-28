import { describe, expect, it, vi } from "vitest";

import {
	COMPONENT_METADATA,
	componentMetadataOf,
	createComponentDecorator,
	finalizeTrainableClass,
	REGISTERED_METHODS,
	type GroundingOptions,
	type GroundingRegistry,
} from "../src/index.js";
import { intent, PENDING_GROUNDINGS } from "../src/decorators.js";

// component.ts is the host seam: it registers a class's methods against a
// registry the host owns, and records component metadata. It was the least
// covered file in the workspace (58% statements, 50% branches), and the
// uncovered half is exactly the fallback behavior a host depends on.

function registry() {
	const registered = new Map<string, GroundingOptions>();
	const spy: GroundingRegistry = {
		has: (methodRef) => registered.has(methodRef),
		register: (_baseline, options) => {
			registered.set(options.methodRef, options);
			return { methodRef: options.methodRef };
		},
	};
	return { registry: spy, registered };
}

describe("finalizeTrainableClass", () => {
	it("registers every own prototype method when nothing was annotated", () => {
		class Bare {
			one(): string { return "one"; }
			two(): string { return "two"; }
		}
		const { registry: host, registered } = registry();
		finalizeTrainableClass(Bare, undefined, host);
		expect([...registered.keys()].sort()).toEqual(["Bare.one", "Bare.two"]);
	});

	it("registers only the annotated methods when some were", () => {
		const metadata: Record<PropertyKey, unknown> = {};
		const pending = new Map([["only", { intent: "declared" }]]);
		metadata[PENDING_GROUNDINGS] = pending;
		class Partial {
			only(): string { return "only"; }
			other(): string { return "other"; }
		}
		const { registry: host, registered } = registry();
		finalizeTrainableClass(Partial, metadata, host);
		expect([...registered.keys()]).toEqual(["Partial.only"]);
		expect(registered.get("Partial.only")?.intent).toBe("declared");
	});

	it("skips the constructor and non-function members", () => {
		class WithField {
			value = 1;
			method(): number { return this.value; }
		}
		const { registry: host, registered } = registry();
		finalizeTrainableClass(WithField, undefined, host);
		expect([...registered.keys()]).toEqual(["WithField.method"]);
	});

	it("first registration wins, so a re-run does not duplicate", () => {
		class Twice { method(): void { /* no-op */ } }
		const { registry: host, registered } = registry();
		finalizeTrainableClass(Twice, undefined, host);
		finalizeTrainableClass(Twice, undefined, host);
		expect(registered.size).toBe(1);
	});

	it("binds the baseline to a lazily constructed instance", () => {
		let constructed = 0;
		class Counted {
			constructor() { constructed += 1; }
			echo(input: unknown): unknown { return input; }
		}
		const baselines: Array<(input: unknown) => unknown> = [];
		finalizeTrainableClass(Counted, undefined, {
			has: () => false,
			register: (baseline, options) => { baselines.push(baseline); return { methodRef: options.methodRef }; },
		});
		// Not constructed just by registering.
		expect(constructed).toBe(0);
		expect(baselines[0]?.("hi")).toBe("hi");
		expect(constructed).toBe(1);
		// Reused, not rebuilt, on a second call.
		baselines[0]?.("again");
		expect(constructed).toBe(1);
	});

	it("falls back to the prototype when the class cannot be constructed", () => {
		class Unconstructible {
			constructor() { throw new Error("no"); }
			echo(input: unknown): unknown { return input; }
		}
		const baselines: Array<(input: unknown) => unknown> = [];
		finalizeTrainableClass(Unconstructible as unknown as new () => object, undefined, {
			has: () => false,
			register: (baseline, options) => { baselines.push(baseline); return { methodRef: options.methodRef }; },
		});
		expect(baselines[0]?.("hi")).toBe("hi");
	});

	it("accumulates registered refs on the metadata record", () => {
		class Recorded { a(): void { /* no-op */ } b(): void { /* no-op */ } }
		const metadata: Record<PropertyKey, unknown> = {};
		const { registry: host } = registry();
		finalizeTrainableClass(Recorded, metadata, host);
		expect(metadata[REGISTERED_METHODS]).toEqual(["Recorded.a", "Recorded.b"]);
	});

	it("honors a custom registered-methods symbol", () => {
		const slot = Symbol("custom");
		class Custom { a(): void { /* no-op */ } }
		const metadata: Record<PropertyKey, unknown> = {};
		finalizeTrainableClass(Custom, metadata, registry().registry, slot);
		expect(metadata[slot]).toEqual(["Custom.a"]);
		expect(metadata[REGISTERED_METHODS]).toBeUndefined();
	});

	it("registers nothing for a class with no own methods", () => {
		class Empty {}
		const { registry: host, registered } = registry();
		finalizeTrainableClass(Empty, undefined, host);
		expect(registered.size).toBe(0);
	});
});

describe("createComponentDecorator", () => {
	const symbols = { component: COMPONENT_METADATA, operations: REGISTERED_METHODS };

	it("records intent, name and operation refs on the class metadata", () => {
		const component = createComponentDecorator(symbols);
		const metadata: Record<PropertyKey, unknown> = { [REGISTERED_METHODS]: ["Widget.render"] };
		class Widget {}
		component({ intent: "Render a widget" })(Widget, {
			kind: "class", name: "Widget", metadata,
		} as unknown as ClassDecoratorContext<typeof Widget>);
		expect(metadata[COMPONENT_METADATA]).toEqual({
			intent: "Render a widget", name: "Widget", operations: ["Widget.render"],
		});
		expect(Object.isFrozen(metadata[COMPONENT_METADATA])).toBe(true);
	});

	it("defaults operations to empty when no method decorator ran", () => {
		const component = createComponentDecorator(symbols);
		const metadata: Record<PropertyKey, unknown> = {};
		class Widget {}
		component({ intent: "i" })(Widget, { kind: "class", name: "Widget", metadata } as never);
		expect((metadata[COMPONENT_METADATA] as { operations: string[] }).operations).toEqual([]);
	});

	it("falls back to the class's own name when the context has none", () => {
		const component = createComponentDecorator(symbols);
		const metadata: Record<PropertyKey, unknown> = {};
		class Fallback {}
		component({ intent: "i" })(Fallback, { kind: "class", metadata } as never);
		expect((metadata[COMPONENT_METADATA] as { name: string }).name).toBe("Fallback");
	});

	it("does nothing when the runtime supplies no metadata record", () => {
		const component = createComponentDecorator(symbols);
		class Widget {}
		expect(() => component({ intent: "i" })(Widget, { kind: "class", name: "Widget" } as never)).not.toThrow();
	});
});

describe("componentMetadataOf", () => {
	it("returns undefined for a class that was never decorated", () => {
		class Plain {}
		expect(componentMetadataOf(Plain)).toBeUndefined();
	});

	it("returns undefined for non-classes and nullish input", () => {
		expect(componentMetadataOf(undefined)).toBeUndefined();
		expect(componentMetadataOf(null)).toBeUndefined();
		expect(componentMetadataOf(42)).toBeUndefined();
	});

	it("reads metadata back off a decorated class", () => {
		const metadataSymbol = (Symbol as { metadata?: symbol }).metadata;
		if (metadataSymbol === undefined) return;
		const value = { intent: "i", name: "N", operations: [] };
		const holder = { [metadataSymbol]: { [COMPONENT_METADATA]: value } };
		expect(componentMetadataOf(holder)).toBe(value);
	});

	it("honors a custom component symbol", () => {
		const metadataSymbol = (Symbol as { metadata?: symbol }).metadata;
		if (metadataSymbol === undefined) return;
		const slot = Symbol.for("custom.component");
		const value = { intent: "i", name: "N", operations: [] };
		const holder = { [metadataSymbol]: { [slot]: value } };
		expect(componentMetadataOf(holder, slot)).toBe(value);
		expect(componentMetadataOf(holder)).toBeUndefined();
	});

	it("returns undefined when Symbol.metadata is unavailable", () => {
		const original = (Symbol as { metadata?: symbol }).metadata;
		try {
			delete (Symbol as { metadata?: symbol }).metadata;
			expect(componentMetadataOf(class {})).toBeUndefined();
		} finally {
			if (original !== undefined) (Symbol as { metadata?: symbol }).metadata = original;
		}
	});
});

describe("granular decorators feeding the finalizer", () => {
	it("carries a declared intent through to registration", () => {
		const metadata: Record<PropertyKey, unknown> = {};
		const context = { name: "route", metadata } as never;
		intent("Route the request")(vi.fn(), context);
		class Router { route(): void { /* no-op */ } }
		const { registry: host, registered } = registry();
		finalizeTrainableClass(Router, metadata, host);
		expect(registered.get("Router.route")?.intent).toBe("Route the request");
	});
});
