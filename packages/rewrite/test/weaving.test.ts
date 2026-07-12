import { configureTesting } from "@aspectjs/common/testing";
import { WeaverModule } from "@aspectjs/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	annotateRewrite,
	configureRewrite,
	dispatchRewrite,
	restoreImplementation,
	swapImplementation,
	swappedImplementation,
	type RewriteInvocation,
} from "../src/index.js";

const MARKER = "use training";

// Weaving is exercised entirely in memory: hot-swapped advice, never source
// edits, so these tests can never rewrite themselves.
describe("rewrite weaving", () => {
	beforeEach(() => {
		configureTesting(WeaverModule);
		configureRewrite({ marker: MARKER });
		restoreImplementation("Router.route");
		restoreImplementation("Router.fallback");
		restoreImplementation("Static.echo");
		restoreImplementation("free.normalize");
	});

	it("weaves annotated methods and leaves sibling methods untouched", () => {
		class Router {
			route(input: string): string { return input; }
			fallback(input: string): string { return input; }
		}
		annotateRewrite(Router, "route", "Router.route", MARKER);
		const seen: string[] = [];
		configureRewrite({ marker: MARKER, intercept: (invocation) => { seen.push(invocation.id); return invocation.proceed(); } });

		const router = new Router();
		expect(router.route("abc")).toBe("abc");
		expect(router.fallback("abc")).toBe("abc");
		expect(seen).toEqual(["Router.route"]);
	});

	it("hot-swaps the live implementation and restores the original", () => {
		class Router {
			route(input: string): string { return input; }
		}
		annotateRewrite(Router, "route", "Router.route", MARKER);
		const router = new Router();

		expect(router.route("abc")).toBe("abc");
		swapImplementation("Router.route", (input) => String(input).toUpperCase());
		expect(router.route("abc")).toBe("ABC");
		expect(typeof swappedImplementation("Router.route")).toBe("function");
		restoreImplementation("Router.route");
		expect(router.route("abc")).toBe("abc");
		expect(swappedImplementation("Router.route")).toBeUndefined();
	});

	it("applies swaps through the interceptor's proceed and preserves this/args", () => {
		class Router {
			prefix = "id:";
			route(input: string): string { return `${this.prefix}${input}`; }
		}
		annotateRewrite(Router, "route", "Router.route", MARKER);
		const invocations: RewriteInvocation[] = [];
		configureRewrite({ marker: MARKER, intercept: (invocation) => { invocations.push(invocation); return invocation.proceed(); } });
		swapImplementation("Router.route", function (this: unknown, input) {
			return `${(this as Router).prefix}${String(input).toUpperCase()}`;
		});

		expect(new Router().route("abc")).toBe("id:ABC");
		expect(invocations[0]?.id).toBe("Router.route");
		expect(invocations[0]?.marker).toBe(MARKER);
		expect(invocations[0]?.methodName).toBe("route");
		expect(invocations[0]?.args).toEqual(["abc"]);
	});

	it("keeps swaps scoped to their rewrite id", () => {
		class Router {
			route(input: string): string { return input; }
			fallback(input: string): string { return input; }
		}
		annotateRewrite(Router, "route", "Router.route", MARKER);
		annotateRewrite(Router, "fallback", "Router.fallback", MARKER);
		swapImplementation("Router.route", () => "swapped");

		const router = new Router();
		expect(router.route("abc")).toBe("swapped");
		expect(router.fallback("abc")).toBe("abc");
	});

	it("annotates idempotently so advice runs once per call", () => {
		class Router {
			route(input: string): string { return input; }
		}
		annotateRewrite(Router, "route", "Router.route", MARKER);
		annotateRewrite(Router, "route", "Router.route", MARKER);
		const intercept = vi.fn((invocation: RewriteInvocation) => invocation.proceed());
		configureRewrite({ marker: MARKER, intercept });

		expect(new Router().route("abc")).toBe("abc");
		expect(intercept).toHaveBeenCalledTimes(1);
	});

	it("weaves static methods and inherited methods through the owning container", () => {
		class Static {
			static echo(input: string): string { return input; }
		}
		annotateRewrite(Static, "echo", "Static.echo", MARKER);
		swapImplementation("Static.echo", (input) => `static:${String(input)}`);
		expect(Static.echo("x")).toBe("static:x");

		class Base {
			route(input: string): string { return input; }
		}
		class Derived extends Base {}
		annotateRewrite(Derived, "route", "Router.route", MARKER);
		swapImplementation("Router.route", () => "woven");
		expect(new Derived().route("abc")).toBe("woven");
		expect(new Base().route("abc")).toBe("woven");
	});

	it("dispatches wrapped free functions through the same swap registry", () => {
		const normalize = (input: string): string => input.trim();
		const call = (input: string): unknown =>
			dispatchRewrite("free.normalize", MARKER, "normalize", normalize as (...args: unknown[]) => unknown, undefined, [input]);

		expect(call("  x  ")).toBe("x");
		swapImplementation("free.normalize", (input) => String(input).trim().toUpperCase());
		expect(call("  x  ")).toBe("X");
		restoreImplementation("free.normalize");
		expect(call("  x  ")).toBe("x");
	});

	it("routes each marker to its own configured interceptor", () => {
		class Router {
			route(input: string): string { return input; }
			ping(input: string): string { return input; }
		}
		const training: string[] = [];
		const audit: string[] = [];
		configureRewrite({ marker: "use training", intercept: (i) => { training.push(i.id); return i.proceed(); } });
		configureRewrite({ marker: "use audit", intercept: (i) => { audit.push(i.id); return i.proceed(); } });
		annotateRewrite(Router, "route", "Router.route", "use training");
		annotateRewrite(Router, "ping", "Router.ping", "use audit");

		const router = new Router();
		router.route("a");
		router.ping("b");
		expect(training).toEqual(["Router.route"]);
		expect(audit).toEqual(["Router.ping"]);
	});
});
