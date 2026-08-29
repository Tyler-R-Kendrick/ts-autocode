import { describe, expect, it } from "vitest";

import { defineTrainable, instrumentTrainable, training, wrapTrainable } from "../src/index.js";

// Decisions the maintainer has made at the ADR level, pinned so they cannot
// be undone as a convenience. Each entry states the decision, refuses the
// rejected spelling at COMPILE time via @ts-expect-error -- if the surface
// ever admits it again, the suppression becomes unused and `npm run
// typecheck` fails -- and shows the accepted spellings still work.

describe("ADR: trainable identity is never a plain string", () => {
	// A plain string is not a sufficient identity to guarantee uniqueness.
	// The accepted identities are the trainable's symbol, its token, or the
	// marked method itself -- each an artifact the marking machinery produced,
	// not text a caller retyped. This was re-admitted once as call-site sugar
	// and rejected; the pin below is what keeps the rejection enforced.
	it("a string identity does not compile, and does not run", async () => {
		await expect(
			// @ts-expect-error -- rejected by ADR: identity must be a symbol, a TrainableToken, or the marked method.
			training.records("Router.route"),
		).rejects.toThrow("must be a symbol or TrainableToken");
	});

	it("a wrapped trainable function is itself an accepted identity", async () => {
		// `wrapTrainable` is what load-time instrumentation applies to a
		// directive-marked function; the wrapper carries the identity the
		// instrumentation declared, so passing the function retypes nothing.
		const marked = wrapTrainable((input: string): string => input, "Adr.byFunction");
		expect(await training.records(marked)).toEqual(
			await training.records(defineTrainable("Adr.byFunction").symbol),
		);
	});

	it("an instrumented class method is itself an accepted identity", async () => {
		class Router {
			route(input: string): string {
				"use training";
				return input;
			}
		}
		instrumentTrainable(Router, "route", "Router.route");

		expect(await training.records(Router.prototype.route)).toEqual(
			await training.records(defineTrainable("Router.route").symbol),
		);
	});

	it("an unmarked function is refused, naming the fix", async () => {
		const unmarked = (input: string): string => input;
		await expect(training.records(unmarked)).rejects.toThrow("is not marked trainable");
	});
});
