import { configureTesting } from "@aspectjs/common/testing";
import { WeaverModule } from "@aspectjs/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	annotateTrainable,
	dispatchTrainable,
	restoreImplementation,
	setTrainableInterceptor,
	swapImplementation,
	swappedImplementation,
	type TrainableInvocation,
} from "../src/index.js";

// Weaving is exercised entirely in memory: hot-swapped advice, never source
// edits, so these tests can never rewrite themselves.
describe("trainable weaving", () => {
	beforeEach(() => {
		configureTesting(WeaverModule);
		setTrainableInterceptor(undefined);
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
		annotateTrainable(Router, "route", "Router.route");
		const seen: string[] = [];
		setTrainableInterceptor((invocation) => {
			seen.push(invocation.id);
			return invocation.proceed();
		});

		const router = new Router();
		expect(router.route("abc")).toBe("abc");
		expect(router.fallback("abc")).toBe("abc");
		expect(seen).toEqual(["Router.route"]);
	});

	it("hot-swaps the live implementation and restores the original", () => {
		class Router {
			route(input: string): string { return input; }
		}
		annotateTrainable(Router, "route", "Router.route");
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
		annotateTrainable(Router, "route", "Router.route");
		const invocations: TrainableInvocation[] = [];
		setTrainableInterceptor((invocation) => {
			invocations.push(invocation);
			return invocation.proceed();
		});
		swapImplementation("Router.route", function (this: unknown, input) {
			return `${(this as Router).prefix}${String(input).toUpperCase()}`;
		});

		expect(new Router().route("abc")).toBe("id:ABC");
		expect(invocations[0]?.id).toBe("Router.route");
		expect(invocations[0]?.methodName).toBe("route");
		expect(invocations[0]?.args).toEqual(["abc"]);
	});

	it("keeps swaps scoped to their trainable id", () => {
		class Router {
			route(input: string): string { return input; }
			fallback(input: string): string { return input; }
		}
		annotateTrainable(Router, "route", "Router.route");
		annotateTrainable(Router, "fallback", "Router.fallback");
		swapImplementation("Router.route", () => "swapped");

		const router = new Router();
		expect(router.route("abc")).toBe("swapped");
		expect(router.fallback("abc")).toBe("abc");
	});

	it("annotates idempotently so advice runs once per call", () => {
		class Router {
			route(input: string): string { return input; }
		}
		annotateTrainable(Router, "route", "Router.route");
		annotateTrainable(Router, "route", "Router.route");
		const interceptor = vi.fn((invocation: TrainableInvocation) => invocation.proceed());
		setTrainableInterceptor(interceptor);

		expect(new Router().route("abc")).toBe("abc");
		expect(interceptor).toHaveBeenCalledTimes(1);
	});

	it("weaves static methods and inherited methods through the owning container", () => {
		class Static {
			static echo(input: string): string { return input; }
		}
		annotateTrainable(Static, "echo", "Static.echo");
		swapImplementation("Static.echo", (input) => `static:${String(input)}`);
		expect(Static.echo("x")).toBe("static:x");

		class Base {
			route(input: string): string { return input; }
		}
		class Derived extends Base {}
		annotateTrainable(Derived, "route", "Router.route");
		swapImplementation("Router.route", () => "woven");
		expect(new Derived().route("abc")).toBe("woven");
		expect(new Base().route("abc")).toBe("woven");
	});

	it("dispatches wrapped free functions through the same swap registry", () => {
		const normalize = (input: string): string => input.trim();
		const call = (input: string): unknown =>
			dispatchTrainable("free.normalize", "normalize", normalize as (...args: unknown[]) => unknown, undefined, [input]);

		expect(call("  x  ")).toBe("x");
		swapImplementation("free.normalize", (input) => String(input).trim().toUpperCase());
		expect(call("  x  ")).toBe("X");
		restoreImplementation("free.normalize");
		expect(call("  x  ")).toBe("x");
	});

	it("interceptors can observe without altering results, and clearing them restores plain dispatch", () => {
		class Router {
			route(input: string): string { return input; }
		}
		annotateTrainable(Router, "route", "Router.route");
		const router = new Router();
		const interceptor = vi.fn((invocation: TrainableInvocation) => invocation.proceed());
		setTrainableInterceptor(interceptor);
		expect(router.route("abc")).toBe("abc");
		expect(interceptor).toHaveBeenCalledTimes(1);

		setTrainableInterceptor(undefined);
		expect(router.route("abc")).toBe("abc");
		expect(interceptor).toHaveBeenCalledTimes(1);
	});
});
