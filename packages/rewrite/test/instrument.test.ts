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
		// The `wrap` handler returns a *different* function on purpose. Returning
		// the original made the assertions pass whether or not the emitted setter
		// worked at all, and rebinding the module's own name is the entire reason
		// the setter is emitted -- it is how a promoted candidate replaces a
		// directive-marked free function.
		const { handlers, methods, wrapped } = recordingInstrumentation();
		const replacement = (input: string) => input.toUpperCase();
		installInstrumentation({
			...handlers,
			wrap: (fn, id) => { wrapped.push(id); return replacement as unknown as typeof fn; },
		});
		const evaluate = new Function(`class Router { route(input) { return input; } }
function normalize(input) { return input; }
${emitInstrumentation(targets)}
return { Router, normalize };`) as () => { Router: unknown; normalize: unknown };
		const scope = evaluate();
		expect(methods).toEqual([{ owner: scope.Router, methodName: "route", id: "Router.route" }]);
		expect(wrapped).toEqual(["normalize"]);
		expect(scope.normalize).toBe(replacement);
	});

	it("emits the entries one per line, so a rewritten module stays readable", () => {
		expect(emitInstrumentation(targets).split("\n")).toHaveLength(4);
	});

	it("appends nothing that would change the file's line endings", () => {
		// This text is appended to the user's own module. Emitting CRLF into an
		// LF file is diff noise the library has no business creating.
		expect(emitInstrumentation(targets)).not.toContain("\r");
	});

	it("rejects names that are not plain identifiers, naming the offender", () => {
		expect(() => emitInstrumentation([{ id: "bad", methodName: "not a name" }]))
			.toThrow(/instrument target must be a plain identifier: not a name/);
	});

	it.each([
		["a leading space", " normalize"],
		["a trailing space", "normalize "],
		["a reserved word", "class"],
		["a member expression", "obj.normalize"],
		["an empty name", ""],
	])("rejects %s as a target name", (_label, methodName) => {
		// Anything but a plain identifier would be emitted straight into the
		// user's module and turn a valid file into a syntax error at load time.
		expect(() => emitInstrumentation([{ id: "bad", methodName }])).toThrow(TypeError);
	});
});

describe("createRewriter", () => {
	const target: InstrumentTarget = { id: "normalize", methodName: "normalize" };

	it("appends a single registration and leaves the original source untouched", () => {
		const rewrite = createRewriter(() => [target], "use audit");
		const source = 'function normalize(input) {\n  "use audit";\n  return input;\n}\n';
		const rewritten = rewrite(source, "/app/normalize.js");
		expect(rewritten.startsWith(source)).toBe(true);
		expect(rewritten).toContain('globalThis[Symbol.for("ts-autocode.instrument")]');
	});

	it("returns the source unchanged on marker miss, discovery failure, or empty discovery", () => {
		const marked = '"use audit"; function f() {}';
		const unmarked = "function f() {}";
		expect(createRewriter(() => [target], "use audit")(unmarked, "/app/f.js")).toBe(unmarked);
		expect(
			createRewriter(() => {
				throw new Error("parse failure");
			}, "use audit")(marked, "/app/f.js"),
		).toBe(marked);
		expect(createRewriter(() => [], "use audit")(marked, "/app/f.js")).toBe(marked);
	});

	it("skips targets whose names cannot be referenced as identifiers", () => {
		const computed: InstrumentTarget = { id: "weird", methodName: "not a name" };
		const marked = '"use audit"; function f() {}';
		expect(createRewriter(() => [computed], "use audit")(marked, "/app/f.js")).toBe(marked);
	});

	it("skips a target whose class name cannot be referenced, keeping the method's own name valid", () => {
		// Only the method name was ever checked here. A class name that does not
		// scan as an identifier would be emitted as `owner: () => Not-A-Class`,
		// which is a syntax error in the file the library just rewrote.
		const marked = '"use audit"; class C { m() {} }';
		const bad: InstrumentTarget = { id: "weird", methodName: "m", className: "Not-A-Class" };
		expect(createRewriter(() => [bad], "use audit")(marked, "/app/c.js")).toBe(marked);

		const good: InstrumentTarget = { id: "C.m", methodName: "m", className: "C" };
		expect(createRewriter(() => [good], "use audit")(marked, "/app/c.js")).not.toBe(marked);
	});

	it("only accepts \"use <name>\" markers", () => {
		// @ts-expect-error markers must be `use ${string}` directives
		expect(() => createRewriter(() => [], "audit")).toThrow(TypeError);
	});
});
