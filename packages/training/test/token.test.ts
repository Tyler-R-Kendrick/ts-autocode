import { describe, expect, it } from "vitest";

import {
	defineTrainable,
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

	it("rejects anything that is not a symbol or token", () => {
		for (const value of ["Router.route", 42, null, undefined, {}, { id: 1 }, []]) {
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
