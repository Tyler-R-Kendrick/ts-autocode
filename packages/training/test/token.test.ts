import { describe, expect, it } from "vitest";

import {
	defineTrainable,
	registerTrainable,
	stampTrainable,
	trainableStamp,
	toTrainableToken,
	trainableIdFromKey,
	trainableTokenFromSymbol,
} from "../src/token.js";
import { InvalidTrainableIdentityError } from "../src/errors.js";

// The token is the durable join key binding a method to its captures, evals,
// candidate and promotion decision. Its normalization and rejection rules are
// the only thing standing between a typo and a silently different identity.

describe("defineTrainable", () => {
	it("produces a stable id and registry symbol", () => {
		const first = defineTrainable("Router.route");
		const second = defineTrainable("Router.route");
		expect(first.id).toBe("Router.route");
		expect(first.symbol).toBe(second.symbol);
		expect(Symbol.keyFor(first.symbol)).toBe("ts-autocode.trainable:Router.route");
	});

	it("trims surrounding whitespace so equivalent spellings agree", () => {
		expect(defineTrainable("  Router.route  ").id).toBe("Router.route");
		expect(defineTrainable("  Router.route  ").symbol).toBe(defineTrainable("Router.route").symbol);
	});

	it("freezes the token", () => {
		expect(Object.isFrozen(defineTrainable("A.b"))).toBe(true);
	});

	it("rejects an empty or whitespace-only id", () => {
		for (const value of ["", "   ", "\t", "\n"]) {
			expect(() => defineTrainable(value)).toThrow(InvalidTrainableIdentityError);
			expect(() => defineTrainable(value)).toThrow("trainable id must be a non-empty string");
		}
	});

	it("distinguishes ids that differ only in case", () => {
		expect(defineTrainable("Router.route").symbol).not.toBe(defineTrainable("router.route").symbol);
	});
});

describe("toTrainableToken", () => {
	it("passes a token through unchanged", () => {
		const token = defineTrainable("A.b");
		expect(toTrainableToken(token)).toBe(token);
	});

	it("resolves a registry symbol back to its token", () => {
		const token = defineTrainable("A.b");
		expect(toTrainableToken(token.symbol).id).toBe("A.b");
	});

	it("accepts a bare Symbol.for key without the library prefix", () => {
		expect(toTrainableToken(Symbol.for("Custom.method")).id).toBe("Custom.method");
	});

	it("resolves a marked callable to the identity its stamp declares", () => {
		const marked = stampTrainable((input: string) => input, defineTrainable("A.marked"));
		expect(toTrainableToken(marked)).toEqual(defineTrainable("A.marked"));
	});

	it("refuses an unmarked callable, naming the fix", () => {
		expect(() => toTrainableToken((input: string) => input)).toThrow(InvalidTrainableIdentityError);
		expect(() => toTrainableToken(function orphan() {} as never)).toThrow("function orphan is not marked trainable");
	});

	it("rejects strings and anything else that is not an identity", () => {
		// ADR: a plain string is never an identity; test/adr.test.ts pins the
		// rejection at compile time, this pins it at runtime.
		for (const value of ["Router.route", 42, null, undefined, {}, { id: 1 }]) {
			expect(() => toTrainableToken(value as never)).toThrow(InvalidTrainableIdentityError);
			expect(() => toTrainableToken(value as never)).toThrow("must be a symbol or TrainableToken");
		}
	});
});

describe("trainableTokenFromSymbol", () => {
	it("uses the description when a symbol is not in the registry", () => {
		expect(trainableTokenFromSymbol(Symbol("Described.method")).id).toBe("Described.method");
	});

	it("rejects a symbol with neither key nor description", () => {
		expect(() => trainableTokenFromSymbol(Symbol())).toThrow("must carry a registry key or description");
	});

	it("rejects a symbol whose description is only whitespace", () => {
		expect(() => trainableTokenFromSymbol(Symbol("   "))).toThrow("must carry a registry key or description");
	});

	it("round-trips every token symbol", () => {
		for (const id of ["A.b", "acme.route", "deeply.nested.name", "with-dash", "with_underscore"]) {
			expect(trainableTokenFromSymbol(defineTrainable(id).symbol).id).toBe(id);
		}
	});
});

describe("trainableIdFromKey", () => {
	it("strips the library prefix", () => {
		expect(trainableIdFromKey("ts-autocode.trainable:Router.route")).toBe("Router.route");
	});

	it("leaves an unprefixed key alone", () => {
		expect(trainableIdFromKey("Router.route")).toBe("Router.route");
	});

	it("strips only the leading prefix, not a later occurrence", () => {
		expect(trainableIdFromKey("ts-autocode.trainable:a:ts-autocode.trainable:b"))
			.toBe("a:ts-autocode.trainable:b");
	});

	it("handles an empty key", () => {
		expect(trainableIdFromKey("")).toBe("");
	});
});

describe("registerTrainable", () => {
	// The symbol index is what makes `train(route)` plain key indexing; every
	// branch here decides which trainable a symbol resolves to, so each one is
	// pinned individually -- a surviving mutant in this file is an identity bug.
	it("binds a unique symbol to the machinery-derived token, keeping the symbol", () => {
		const key: unique symbol = Symbol("key");
		const bound = registerTrainable(key, defineTrainable("Derived.method"));
		expect(bound.id).toBe("Derived.method");
		expect(bound.symbol).toBe(key);
		expect(Object.isFrozen(bound)).toBe(true);
	});

	it("resolves through the index, not the symbol description", () => {
		// The description would derive a *different* id; the index must win, or
		// a unique symbol silently forks into a description-named trainable.
		const misleading: unique symbol = Symbol("Misleading.name");
		registerTrainable(misleading, defineTrainable("Actual.target"));
		expect(toTrainableToken(misleading).id).toBe("Actual.target");
	});

	it("is idempotent for the same declaration", () => {
		const key: unique symbol = Symbol("again");
		registerTrainable(key, defineTrainable("Same.method"));
		expect(registerTrainable(key, defineTrainable("Same.method")).id).toBe("Same.method");
		expect(toTrainableToken(key).id).toBe("Same.method");
	});

	it("refuses to rebind a symbol to a different declaration", () => {
		const key: unique symbol = Symbol("taken");
		registerTrainable(key, defineTrainable("First.method"));
		expect(() => registerTrainable(key, defineTrainable("Second.method")))
			.toThrow(InvalidTrainableIdentityError);
		expect(() => registerTrainable(key, defineTrainable("Second.method")))
			.toThrow("already registered to First.method");
		// The failed rebind must not have corrupted the existing binding.
		expect(toTrainableToken(key).id).toBe("First.method");
	});

	it("leaves unregistered symbols on the registry/description path", () => {
		expect(toTrainableToken(Symbol.for("ts-autocode.trainable:Registry.method")).id).toBe("Registry.method");
	});
});

describe("stampTrainable", () => {
	it("stamps only functions, passing other values through untouched", () => {
		const value = { id: "not-a-function" };
		expect(stampTrainable(value, defineTrainable("X.y"))).toBe(value);
		expect(Object.getOwnPropertySymbols(value)).toEqual([]);

		const fn = (input: string): string => input;
		expect(stampTrainable(fn, defineTrainable("X.y"))).toBe(fn);
		expect(toTrainableToken(fn).id).toBe("X.y");
	});

	it("stamps non-enumerably, so serialization never sees it", () => {
		const fn = stampTrainable((input: string): string => input, defineTrainable("Quiet.fn"));
		expect(Object.keys(fn)).toEqual([]);
		expect(JSON.stringify({ fn: undefined })).not.toContain("Quiet.fn");
	});
});

describe("the stamp protocol", () => {
	it("uses the published registry key, which other packages may address", () => {
		// The stamp is cross-package protocol: instrumentation writes it without
		// this package importing it back. The exact key is the contract.
		expect(Symbol.keyFor(trainableStamp)).toBe("ts-autocode.trainable.id");
	});

	it("restamps rather than freezing the first identity in place", () => {
		// Instrumentation may legitimately stamp the same callable again (the
		// decorator stamps both the original method and the woven slot); the
		// property stays configurable so the later, more specific stamp wins.
		const fn = (input: string): string => input;
		stampTrainable(fn, defineTrainable("First.stamp"));
		stampTrainable(fn, defineTrainable("Second.stamp"));
		expect(toTrainableToken(fn).id).toBe("Second.stamp");
	});

	it("names an anonymous function as such when refusing it", () => {
		const anonymous = (input: string): string => input;
		Object.defineProperty(anonymous, "name", { value: "" });
		expect(() => toTrainableToken(anonymous)).toThrow("function (anonymous) is not marked trainable");
	});
});

describe("unregistered unique symbols", () => {
	it("fail loudly instead of deriving an id from the description", () => {
		// The description is user-typed text; deriving an id from it would be
		// string identity by the back door, and could silently target a
		// directive-marked trainable that happens to share the name.
		const unregistered: unique symbol = Symbol("Router.route");
		expect(() => toTrainableToken(unregistered)).toThrow(InvalidTrainableIdentityError);
		expect(() => toTrainableToken(unregistered)).toThrow(
			"Symbol(Router.route) is not a registered trainable; @trainable(symbol) registers it at first construction",
		);
	});
});
