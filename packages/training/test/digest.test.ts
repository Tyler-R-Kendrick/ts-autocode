import { describe, expect, it } from "vitest";

import { digest } from "../src/digest.js";

// The body digest is what guarded application re-computes to decide whether the
// file changed since discovery. Mutation testing scored this module at 13.9%:
// its only tests lived in other packages, so key sorting, the plain-object
// check and the array branch could all be broken undetected.

describe("digest", () => {
	it("is deterministic and shaped as documented", () => {
		expect(digest({ a: 1 })).toBe(digest({ a: 1 }));
		expect(digest("body")).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	it("sorts object keys at every depth", () => {
		expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }));
		expect(digest({ x: { a: 1, b: 2 } })).toBe(digest({ x: { b: 2, a: 1 } }));
		expect(digest({ x: [{ a: 1, b: 2 }] })).toBe(digest({ x: [{ b: 2, a: 1 }] }));
	});

	it("preserves array order", () => {
		expect(digest([1, 2, 3])).not.toBe(digest([3, 2, 1]));
		expect(digest([{ a: 1 }, { b: 2 }])).not.toBe(digest([{ b: 2 }, { a: 1 }]));
	});

	it("distinguishes values, types and nesting", () => {
		expect(digest({ a: 1 })).not.toBe(digest({ a: 2 }));
		expect(digest({ a: 1 })).not.toBe(digest({ b: 1 }));
		expect(digest("1")).not.toBe(digest(1));
		expect(digest([1])).not.toBe(digest(1));
		expect(digest({ a: { b: 1 } })).not.toBe(digest({ a: { b: { c: 1 } } }));
		expect(digest(null)).not.toBe(digest(undefined));
		expect(digest(true)).not.toBe(digest(false));
	});

	it("treats a null-prototype object as a plain record", () => {
		const bare = Object.create(null) as Record<string, unknown>;
		bare["b"] = 1;
		bare["a"] = 2;
		expect(digest(bare)).toBe(digest({ a: 2, b: 1 }));
	});

	it("does not canonicalize class instances into empty objects", () => {
		// If the plain-object check accepted them, every Date would hash alike.
		expect(digest(new Date("2020-01-01"))).not.toBe(digest(new Date("2021-01-01")));
		expect(digest(new Map([["a", 1]]))).not.toBe(digest({ a: 1 }));
		class Holder { constructor(readonly value: number) {} }
		expect(digest(new Holder(1))).not.toBe(digest(new Holder(2)));
	});

	it("distinguishes an array from an object with numeric keys", () => {
		expect(digest([1, 2])).not.toBe(digest({ 0: 1, 1: 2 }));
	});

	it("distinguishes whitespace, which is why the raw body slice is hashed", () => {
		expect(digest("return input;")).not.toBe(digest(" return input; "));
		expect(digest("a\nb")).not.toBe(digest("a\r\nb"));
	});

	it("handles empty containers distinctly", () => {
		expect(digest({})).not.toBe(digest([]));
		expect(digest("")).not.toBe(digest({}));
	});
});
