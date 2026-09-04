import { describe, expect, it } from "vitest";

import { defined, optional } from "../src/optional.js";

// `exactOptionalPropertyTypes` forbids assigning an explicit `undefined` to an
// optional property, so the distinction these helpers exist for is "key absent"
// versus "key present with value undefined". Asserting only deep equality would
// miss that entirely, since `{a: undefined}` and `{}` compare equal under
// toEqual, so these check key presence directly.

describe("optional", () => {
	it("includes the key when the value is defined", () => {
		expect({ ...optional("signal", "abc") }).toEqual({ signal: "abc" });
		expect(Object.keys({ ...optional("signal", "abc") })).toEqual(["signal"]);
	});

	it("omits the key entirely when the value is undefined", () => {
		const spread = { ...optional("signal", undefined) };
		expect(Object.keys(spread)).toEqual([]);
		// `Object.hasOwn`, not `in`: `in` walks the prototype chain.
		expect(Object.hasOwn(spread, "signal")).toBe(false);
	});

	it("keeps falsy-but-defined values, which is the whole point", () => {
		for (const value of [0, "", false, Number.NaN, null] as const) {
			const spread = { ...optional("v", value) };
			expect(Object.hasOwn(spread, "v")).toBe(true);
			expect((spread as { v: unknown }).v).toBe(value === value ? value : (spread as { v: number }).v);
		}
		expect(Number.isNaN(({ ...optional("v", Number.NaN) } as { v: number }).v)).toBe(true);
	});

	it("preserves object identity rather than cloning", () => {
		const signal = new AbortController().signal;
		expect(({ ...optional("signal", signal) } as { signal: AbortSignal }).signal).toBe(signal);
	});

	it("composes so later spreads win, as object spread does", () => {
		expect({ a: 1, ...optional("a", 2) }).toEqual({ a: 2 });
		expect({ a: 1, ...optional("a", undefined) }).toEqual({ a: 1 });
	});
});

describe("defined", () => {
	it("drops only the undefined entries", () => {
		expect({ ...defined({ a: 1, b: undefined, c: "x" }) }).toEqual({ a: 1, c: "x" });
	});

	it("keeps null and other falsy values", () => {
		const spread = { ...defined({ a: null, b: 0, c: false, d: "", e: undefined }) };
		expect(Object.keys(spread).sort()).toEqual(["a", "b", "c", "d"]);
	});

	it("returns an empty object when everything is undefined", () => {
		expect(Object.keys({ ...defined({ a: undefined, b: undefined }) })).toEqual([]);
	});

	it("handles an empty input", () => {
		expect({ ...defined({}) }).toEqual({});
	});

	it("does not mutate its input", () => {
		const input = { a: 1, b: undefined };
		defined(input);
		expect("b" in input).toBe(true);
	});

	it("copies own enumerable keys only", () => {
		const base = Object.create({ inherited: "no" }) as Record<string, unknown>;
		base["own"] = "yes";
		expect({ ...defined(base) }).toEqual({ own: "yes" });
	});
});

describe("keys that shadow Object.prototype", () => {
	// `defined` built its result with `result[key] = value`, which goes through
	// the `__proto__` setter: a `__proto__` key was silently dropped, and with
	// an object value it replaced the result's prototype instead of adding a
	// key. Found by a property test over arbitrary dictionaries.
	const dangerous = ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf"];

	it.each(dangerous)("defined keeps a %s key as an own property", (key) => {
		const result = defined(JSON.parse(`{"${key}": 1}`) as Record<string, unknown>);
		expect(Object.hasOwn(result, key)).toBe(true);
		expect((result as Record<string, unknown>)[key]).toBe(1);
	});

	it.each(dangerous)("optional keeps a %s key as an own property", (key) => {
		const result = { ...optional(key, 1) };
		expect(Object.hasOwn(result, key)).toBe(true);
	});

	it("never lets a __proto__ value replace the result's prototype", () => {
		const result = defined(JSON.parse('{"__proto__": {"isAdmin": true}}') as Record<string, unknown>);
		expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
		expect((result as Record<string, unknown>)["isAdmin"]).toBeUndefined();
		expect(Object.getPrototypeOf({ ...optional("__proto__", { isAdmin: true }) })).toBe(Object.prototype);
	});

	it("does not pollute Object.prototype itself", () => {
		defined(JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>);
		expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
	});

	it("still drops an undefined value under a dangerous key", () => {
		const result = defined({ ["__proto__"]: undefined } as Record<string, unknown>);
		expect(Object.getOwnPropertyNames(result)).toEqual([]);
	});
});
