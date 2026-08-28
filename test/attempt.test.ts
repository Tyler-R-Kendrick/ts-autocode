import { describe, expect, it } from "vitest";

import { attempt, attemptAsync, errorMessage } from "../src/attempt.js";

// These were Effect-backed and are now plain try/catch. The fallback branch had
// zero coverage in the root copy, which is the branch that matters: it is the
// boundary that keeps a capture or serialization failure from breaking a
// traced application call.

describe("errorMessage", () => {
	it("uses an Error's message", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
		expect(errorMessage(new TypeError("typed"))).toBe("typed");
	});

	it("stringifies anything else", () => {
		expect(errorMessage("plain")).toBe("plain");
		expect(errorMessage(42)).toBe("42");
		expect(errorMessage(null)).toBe("null");
		expect(errorMessage(undefined)).toBe("undefined");
		expect(errorMessage({ toString: () => "custom" })).toBe("custom");
	});

	it("keeps a subclass message", () => {
		class Custom extends Error {}
		expect(errorMessage(new Custom("sub"))).toBe("sub");
	});
});

describe("attempt", () => {
	it("returns the value when nothing throws", () => {
		expect(attempt(() => 1, () => 2)).toBe(1);
	});

	it("returns the fallback when the body throws", () => {
		expect(attempt(() => { throw new Error("x"); }, () => 2)).toBe(2);
	});

	it("hands the raw thrown value to the fallback, not a wrapper", () => {
		const thrown = { code: "E" };
		expect(attempt(() => { throw thrown; }, (error) => error)).toBe(thrown);
	});

	it("propagates a throw from the fallback itself", () => {
		expect(() => attempt(() => { throw new Error("first"); }, () => { throw new Error("second"); }))
			.toThrow("second");
	});

	it("preserves falsy return values rather than treating them as failure", () => {
		expect(attempt(() => 0, () => 99)).toBe(0);
		expect(attempt(() => undefined, () => 99)).toBeUndefined();
	});

	it("runs synchronously", () => {
		const order: string[] = [];
		order.push("before");
		attempt(() => order.push("body"), () => order.push("fallback"));
		order.push("after");
		expect(order).toEqual(["before", "body", "after"]);
	});
});

describe("attemptAsync", () => {
	it("resolves the value when nothing rejects", async () => {
		await expect(attemptAsync(async () => 1, () => 2)).resolves.toBe(1);
	});

	it("resolves the fallback when the promise rejects", async () => {
		await expect(attemptAsync(async () => { throw new Error("x"); }, () => 2)).resolves.toBe(2);
	});

	it("resolves the fallback when the body throws synchronously", async () => {
		await expect(attemptAsync(() => { throw new Error("sync"); }, () => 3)).resolves.toBe(3);
	});

	it("hands the raw rejection value to the fallback", async () => {
		const thrown = { code: "E" };
		await expect(attemptAsync(async () => { throw thrown; }, (error) => error)).resolves.toBe(thrown);
	});

	it("rejects when the fallback throws", async () => {
		await expect(attemptAsync(async () => { throw new Error("first"); }, () => { throw new Error("second"); }))
			.rejects.toThrow("second");
	});
});
