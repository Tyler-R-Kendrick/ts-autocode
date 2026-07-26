import { describe, expect, it } from "vitest";

import {
	composeOptions,
	finalizeTrainableClass,
	granularOptionsFor,
	intent,
	param,
	PENDING_GROUNDINGS,
	returns,
	type GroundingOptions,
	type PendingMap,
} from "../src/index.js";

(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

function stage3Method(metadata: Record<PropertyKey, unknown>, name: string) {
	return { kind: "method", name, metadata } as const;
}

describe("granular grounding decorators", () => {
	it("@intent and @returns accumulate stage-3 pending groundings", () => {
		const metadata: Record<PropertyKey, unknown> = {};
		const method = () => "hi";
		expect(intent("Say hello")(method, stage3Method(metadata, "greet"))).toBe(method);
		returns("A greeting")(method, stage3Method(metadata, "greet"));
		const pending = metadata[PENDING_GROUNDINGS] as PendingMap;
		expect(pending.get("greet")).toEqual({ intent: "Say hello", returns: "A greeting" });
	});

	it("composeOptions infers intent and lowers returns to output metadata", () => {
		expect(composeOptions("Program.run", undefined)).toEqual({
			methodRef: "Program.run",
			intent: "Inferred: implement Program.run to satisfy its declared signature and descriptions.",
			contract: { ref: "decl://Program.run" },
		});
		expect(composeOptions("P.m", { intent: "Do it", returns: "The result", params: { x: param("An x") } })).toEqual({
			methodRef: "P.m",
			intent: "Do it",
			contract: { ref: "decl://P.m" },
			params: { x: { description: "An x" } },
			output: { returns: { description: "The result" } },
		});
	});

	it("granularOptionsFor reads the pending grounding for a method", () => {
		const metadata: Record<PropertyKey, unknown> = {};
		intent("Route things")(() => 1, stage3Method(metadata, "route"));
		expect(granularOptionsFor("Router.route", metadata, "route").intent).toBe("Route things");
		expect(granularOptionsFor("Router.other", metadata, "other").intent).toContain("Inferred:");
	});

	it("finalizeTrainableClass registers annotated methods against the host registry", () => {
		const metadata: Record<PropertyKey, unknown> = {};
		class Greeter {
			greet(name: string): string {
				return `Hello, ${name}!`;
			}
			ignored(): void {}
		}
		intent("Say hello")(Greeter.prototype.greet, stage3Method(metadata, "greet"));

		const registered = new Map<string, { baseline: (input: unknown) => unknown; options: GroundingOptions }>();
		finalizeTrainableClass(Greeter, metadata, {
			has: (ref) => registered.has(ref),
			register: (baseline, options) => {
				registered.set(options.methodRef, { baseline, options });
				return { methodRef: options.methodRef };
			},
		});

		// Only the annotated method registers (pending map non-empty).
		expect([...registered.keys()]).toEqual(["Greeter.greet"]);
		expect(registered.get("Greeter.greet")?.options.intent).toBe("Say hello");
		expect(registered.get("Greeter.greet")?.baseline("World")).toBe("Hello, World!");
	});

	it("finalizeTrainableClass registers every own method when nothing was annotated", () => {
		class Bare {
			one(): number {
				return 1;
			}
			two(): number {
				return 2;
			}
		}
		const refs: string[] = [];
		finalizeTrainableClass(Bare, {}, {
			has: () => false,
			register: (_baseline, options) => {
				refs.push(options.methodRef);
				return { methodRef: options.methodRef };
			},
		});
		expect(refs.sort()).toEqual(["Bare.one", "Bare.two"]);
	});
});
