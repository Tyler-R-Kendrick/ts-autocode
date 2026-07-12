import { afterEach, describe, expect, it } from "vitest";

import ts from "typescript";

import {
	createRewriter,
	emitInstrumentation,
	installInstrumentation,
	installedInstrumentation,
	instrumentKey,
	type InstrumentEntry,
	type InstrumentRegistry,
	type InstrumentTarget,
	type Instrumentation,
} from "../src/index.js";

const registrySlot = Symbol.for(instrumentKey);
const globalSlots = globalThis as Record<symbol, unknown>;
const previousRegistry = globalSlots[registrySlot];

afterEach(() => {
	globalSlots[registrySlot] = previousRegistry;
});

function recordingInstrumentation() {
	const methods: { owner: unknown; methodName: string; id: string }[] = [];
	const wrapped: string[] = [];
	const handlers: Instrumentation = {
		method: (owner, methodName, id) => {
			methods.push({ owner, methodName, id });
		},
		wrap: (fn, id) => {
			wrapped.push(id);
			return fn;
		},
	};
	return { handlers, methods, wrapped };
}

function installedRegistry(): InstrumentRegistry {
	const registry = globalSlots[registrySlot];
	expect(typeof registry).toBe("function");
	return registry as InstrumentRegistry;
}

describe("instrumentation interpreter", () => {
	it("dispatches method entries to the handlers and skips non-function owners", () => {
		const { handlers, methods } = recordingInstrumentation();
		installInstrumentation(handlers);
		class Router {}
		installedRegistry()([
			{ id: "Router.route", name: "route", owner: () => Router },
			{ id: "Missing.route", name: "route", owner: () => undefined },
		]);
		expect(methods).toEqual([{ owner: Router, methodName: "route", id: "Router.route" }]);
	});

	it("wraps function entries and hands the wrapped function to the setter", () => {
		const replacement = (input: string) => input.toUpperCase();
		installInstrumentation({
			method: () => {},
			wrap: (fn) => replacement as unknown as typeof fn,
		});
		let normalize: unknown = (input: string) => input;
		installedRegistry()([{ id: "normalize", get: () => normalize, set: (fn) => (normalize = fn) }]);
		expect(normalize).toBe(replacement);
	});

	it("never lets a failing entry break the batch", () => {
		const { handlers, methods } = recordingInstrumentation();
		installInstrumentation(handlers);
		class Router {}
		const throwing: InstrumentEntry[] = [
			{
				id: "broken",
				get: () => {
					throw new ReferenceError("not defined");
				},
				set: () => {},
			},
			{ id: "Router.route", name: "route", owner: () => Router },
		];
		expect(() => installedRegistry()(throwing)).not.toThrow();
		expect(methods).toHaveLength(1);
	});

	it("round-trips the installed handlers and freezes the registry", () => {
		const { handlers } = recordingInstrumentation();
		installInstrumentation(handlers);
		expect(installedInstrumentation()).toBe(handlers);
		expect(Object.isFrozen(globalSlots[registrySlot])).toBe(true);
	});
});

describe("instrumentation emission", () => {
	const targets: InstrumentTarget[] = [
		{ id: "Router.route", methodName: "route", className: "Router" },
		{ id: "normalize", methodName: "normalize" },
	];

	it("emits syntactically valid JavaScript", () => {
		const emitted = emitInstrumentation(targets);
		const { diagnostics } = ts.transpileModule(emitted, { reportDiagnostics: true });
		expect(diagnostics ?? []).toHaveLength(0);
	});

	it("registers working accessors when evaluated in the module's scope", () => {
		const { handlers, methods, wrapped } = recordingInstrumentation();
		installInstrumentation(handlers);
		const evaluate = new Function(`class Router { route(input) { return input; } }
function normalize(input) { return input; }
${emitInstrumentation(targets)}
return { Router, normalize };`) as () => { Router: unknown; normalize: unknown };
		const scope = evaluate();
		expect(methods).toEqual([{ owner: scope.Router, methodName: "route", id: "Router.route" }]);
		expect(wrapped).toEqual(["normalize"]);
	});

	it("rejects names that are not plain identifiers", () => {
		expect(() => emitInstrumentation([{ id: "bad", methodName: "not a name" }])).toThrow(TypeError);
	});
});

describe("createRewriter", () => {
	const target: InstrumentTarget = { id: "normalize", methodName: "normalize" };

	it("appends a single registration and leaves the original source untouched", () => {
		const rewrite = createRewriter(() => [target], "use training");
		const source = 'function normalize(input) {\n  "use training";\n  return input;\n}\n';
		const rewritten = rewrite(source, "/app/normalize.js");
		expect(rewritten.startsWith(source)).toBe(true);
		expect(rewritten).toContain('globalThis[Symbol.for("ts-autocode.instrument")]');
	});

	it("returns the source unchanged on marker miss, discovery failure, or empty discovery", () => {
		const marked = '"use training"; function f() {}';
		const unmarked = "function f() {}";
		expect(createRewriter(() => [target], "use training")(unmarked, "/app/f.js")).toBe(unmarked);
		expect(
			createRewriter(() => {
				throw new Error("parse failure");
			}, "use training")(marked, "/app/f.js"),
		).toBe(marked);
		expect(createRewriter(() => [], "use training")(marked, "/app/f.js")).toBe(marked);
	});

	it("skips targets whose names cannot be referenced as identifiers", () => {
		const computed: InstrumentTarget = { id: "weird", methodName: "not a name" };
		const marked = '"use training"; function f() {}';
		expect(createRewriter(() => [computed], "use training")(marked, "/app/f.js")).toBe(marked);
	});

	it("only accepts \"use <name>\" markers", () => {
		// @ts-expect-error markers must be `use ${string}` directives
		expect(() => createRewriter(() => [], "training")).toThrow(TypeError);
	});
});
