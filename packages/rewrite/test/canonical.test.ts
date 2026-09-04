import { describe, expect, it } from "vitest";

import { check, digest } from "../src/canonical.js";

// The digest is a cross-package protocol: guarded rewriting refuses a candidate
// whose target body digest no longer matches, so training and rewrite must hash
// identical content identically. `isRecord`'s prototype check is the subtle
// part -- class instances must NOT be key-sorted into `{}`.

describe("digest", () => {
	it("is stable for the same value", () => {
		expect(digest({ a: 1 })).toBe(digest({ a: 1 }));
	});

	it("ignores key order, which is the point of canonicalization", () => {
		expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }));
		expect(digest({ outer: { x: 1, y: 2 } })).toBe(digest({ outer: { y: 2, x: 1 } }));
	});

	it("respects array order, which is meaningful", () => {
		expect(digest([1, 2])).not.toBe(digest([2, 1]));
	});

	it("sorts keys inside arrays too", () => {
		expect(digest([{ a: 1, b: 2 }])).toBe(digest([{ b: 2, a: 1 }]));
	});

	it("distinguishes different values", () => {
		expect(digest({ a: 1 })).not.toBe(digest({ a: 2 }));
		expect(digest("a")).not.toBe(digest("b"));
	});

	it("handles primitives and null-prototype objects", () => {
		for (const value of ["s", 1, true, null, [], {}]) {
			expect(digest(value)).toMatch(/^sha256:[0-9a-f]{64}$/);
		}
		const bare = Object.create(null) as Record<string, unknown>;
		bare["b"] = 1;
		bare["a"] = 2;
		expect(digest(bare)).toBe(digest({ a: 2, b: 1 }));
	});

	it("hashes undefined rather than throwing on it", () => {
		// `isRecord`'s `typeof` guard is what keeps `undefined` away from
		// `Object.getPrototypeOf`, which throws on it. Optional fields reach the
		// digest undefined -- candidate `metadata` is one -- so this is the
		// ordinary case, not a hostile input.
		expect(digest(undefined)).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(digest({ metadata: undefined })).toBe(digest({}));
		expect(digest([undefined])).toBe(digest([null]));
	});

	it("does not canonicalize class instances into empty objects", () => {
		// A Date serializes through JSON.stringify; if isRecord wrongly accepted
		// it, every Date would hash identically.
		expect(digest(new Date("2020-01-01"))).not.toBe(digest(new Date("2021-01-01")));
		expect(digest(new Map([["a", 1]]))).toBe(digest({}));
	});

	it("returns the documented prefix and hex length", () => {
		expect(digest("x")).toMatch(/^sha256:[0-9a-f]{64}$/);
	});
});

describe("check", () => {
	it("passes a truthy condition through", () => {
		expect(() => check(1, "unused")).not.toThrow();
		expect(() => check("non-empty", "unused")).not.toThrow();
	});

	it("throws the given message for every falsy condition", () => {
		for (const value of [false, 0, "", null, undefined, Number.NaN]) {
			expect(() => check(value, "boom")).toThrow("boom");
		}
	});
});
