import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
	CandidateSyntaxError,
	EngineContractError,
	EngineNotConfiguredError,
	EngineProposalError,
	ExecutorNotConfiguredError,
	InsufficientTracesError,
	InvalidSettingsError,
	InvalidTrainableIdentityError,
	isTsAutocodeError,
	LoopCapabilityError,
	MissingSecretError,
	OperationInterruptedError,
	parseSetting,
	PromotionApplierNotConfiguredError,
	PromotionRejectedError,
	SourceDiscoveryError,
	TraceNotFoundError,
	TrainingIncompleteError,
	TsAutocodeError,
	TsAutocodeSyntaxError,
	TsAutocodeTypeError,
	type TsAutocodeErrorCode,
} from "../src/errors.js";

// Atomic coverage of the error family: every constructor, every static factory,
// every branch of the brand-based `hasInstance`, and the Zod boundary. The
// family was added with only a handful of these exercised (16% branch), which
// is exactly the sort of gap a "we have tests" claim hides.

/** Every concrete error, with the code and message each must produce. */
const cases: ReadonlyArray<readonly [string, () => Error, TsAutocodeErrorCode, string]> = [
	["EngineNotConfiguredError", () => new EngineNotConfiguredError(), "engine_not_configured",
		'no training engine is configured; import "ts-autocode" for the Ax default or set TrainingSettings.engine'],
	["ExecutorNotConfiguredError", () => new ExecutorNotConfiguredError(), "executor_not_configured",
		'candidate execution requires an executor; import "ts-autocode" or set TrainingSettings.executor'],
	["PromotionApplierNotConfiguredError", () => new PromotionApplierNotConfiguredError(), "applier_not_configured",
		'activation requires a promotion applier; import "ts-autocode" for the default or set TrainingProviders.promote'],
	["PromotionRejectedError", () => new PromotionRejectedError("cand-9"), "promotion_rejected",
		"candidate has not passed the promotion gate: cand-9"],
	["InsufficientTracesError", () => new InsufficientTracesError(4, 2), "insufficient_traces",
		"training from captured traffic requires 4 distinct successful runtime traces; found 2"],
	["TraceNotFoundError", () => new TraceNotFoundError("abc"), "trace_not_found",
		"live trace was not found for eval input: abc"],
	["CandidateSyntaxError", () => new CandidateSyntaxError("Router.route"), "candidate_syntax",
		"engine returned invalid TypeScript for Router.route"],
	["EngineContractError", () => new EngineContractError("bad contract"), "engine_contract", "bad contract"],
	["EngineProposalError", () => new EngineProposalError("no candidate"), "engine_proposal", "no candidate"],
	["MissingSecretError", () => new MissingSecretError("K", "needs K"), "missing_secret", "needs K"],
	["LoopCapabilityError", () => new LoopCapabilityError("cannot fan out"), "loop_capability", "cannot fan out"],
	["InvalidTrainableIdentityError", () => new InvalidTrainableIdentityError("bad id"), "invalid_identity", "bad id"],
	["SourceDiscoveryError", () => new SourceDiscoveryError("not found"), "source_discovery", "not found"],
	["OperationInterruptedError", () => new OperationInterruptedError("propose"), "operation_interrupted",
		"propose was interrupted"],
	["InvalidSettingsError", () => new InvalidSettingsError("bad setting"), "invalid_settings", "bad setting"],
	["TrainingIncompleteError.noRounds", () => TrainingIncompleteError.noRounds("stalled"), "training_incomplete",
		"training loop returned no rounds: stalled"],
	["TrainingIncompleteError.noPromotableCandidate", () => TrainingIncompleteError.noPromotableCandidate("exhausted"),
		"training_incomplete", "background training did not produce a promotable candidate: exhausted"],
];

describe.each(cases)("%s", (name, build, code, message) => {
	it("carries its code, message and name", () => {
		const error = build();
		expect((error as Error & { code: string }).code).toBe(code);
		expect(error.message).toBe(message);
		expect(error.name).toBe(name.split(".")[0]);
	});

	it("is recognized as part of the family", () => {
		expect(isTsAutocodeError(build())).toBe(true);
		expect(build()).toBeInstanceOf(TsAutocodeError);
		expect(build()).toBeInstanceOf(Error);
	});

	it("has a usable stack", () => {
		expect(typeof build().stack).toBe("string");
	});
});

describe("brand-based family membership", () => {
	it("rejects non-errors and foreign errors", () => {
		for (const value of [undefined, null, 0, "", "err", {}, [], new Error("plain"), new TypeError("plain")]) {
			expect(isTsAutocodeError(value)).toBe(false);
			expect(value).not.toBeInstanceOf(TsAutocodeError);
		}
	});

	it("keeps subclass instanceof exact rather than brand-wide", () => {
		const engine = new EngineNotConfiguredError();
		expect(engine).toBeInstanceOf(EngineNotConfiguredError);
		expect(engine).not.toBeInstanceOf(ExecutorNotConfiguredError);
		expect(engine).not.toBeInstanceOf(LoopCapabilityError);
		// And a TypeError-rooted member is not an instance of an Error-rooted one.
		expect(new InvalidSettingsError("x")).not.toBeInstanceOf(EngineNotConfiguredError);
	});

	it("keeps the builtin prototypes the family grafts onto", () => {
		expect(new InvalidTrainableIdentityError("x")).toBeInstanceOf(TypeError);
		expect(new InvalidTrainableIdentityError("x")).toBeInstanceOf(TsAutocodeTypeError);
		expect(new CandidateSyntaxError("x")).toBeInstanceOf(SyntaxError);
		expect(new CandidateSyntaxError("x")).toBeInstanceOf(TsAutocodeSyntaxError);
		// All three roots still answer to the family check.
		for (const error of [new EngineNotConfiguredError(), new InvalidSettingsError("x"), new CandidateSyntaxError("x")]) {
			expect(error).toBeInstanceOf(TsAutocodeError);
		}
	});

	it("does not treat a hand-rolled look-alike as a member", () => {
		class Impostor extends Error { readonly code = "engine_not_configured"; }
		expect(isTsAutocodeError(new Impostor("nope"))).toBe(false);
	});
});

describe("error payloads", () => {
	it("PromotionRejectedError exposes failures only when it has a decision", () => {
		expect(new PromotionRejectedError("c1").failures).toEqual([]);
		expect(new PromotionRejectedError("c1").decision).toBeUndefined();
		const decision = { candidateId: "c1", promote: false, failures: ["a", "b"], meanScore: 0.2, passRate: 0.5 };
		const rejected = new PromotionRejectedError("c1", decision);
		expect(rejected.failures).toEqual(["a", "b"]);
		expect(rejected.decision).toBe(decision);
		expect(rejected.candidateId).toBe("c1");
	});

	it("InsufficientTracesError pluralizes only when it should", () => {
		expect(new InsufficientTracesError(1, 0).message).toContain("1 distinct successful runtime trace;");
		expect(new InsufficientTracesError(2, 0).message).toContain("2 distinct successful runtime traces;");
		expect(new InsufficientTracesError(3, 1)).toMatchObject({ required: 3, found: 1 });
	});

	it("TrainingIncompleteError keeps the outcome it was built from", () => {
		expect(TrainingIncompleteError.noRounds("stalled").outcome).toBe("stalled");
		expect(TrainingIncompleteError.noPromotableCandidate("exhausted").outcome).toBe("exhausted");
	});

	it("carries the identifying detail each error was given", () => {
		expect(new TraceNotFoundError("in").input).toBe("in");
		expect(new CandidateSyntaxError("T.m").trainableId).toBe("T.m");
		expect(new MissingSecretError("K", "m").secret).toBe("K");
		expect(new OperationInterruptedError("op").operation).toBe("op");
	});

	it("supports a cause, so a wrapped failure is not lost", () => {
		const cause = new Error("underlying");
		expect(new InvalidSettingsError("outer", { cause }).cause).toBe(cause);
	});
});

describe("parseSetting", () => {
	const schema = z.number().int().positive("must be a positive integer");

	it("returns the parsed value unchanged when valid", () => {
		expect(parseSetting(schema, 3)).toBe(3);
	});

	it("raises the schema's own message as a library error, not a ZodError", () => {
		let thrown: unknown;
		try {
			parseSetting(schema, -1);
		} catch (error) {
			thrown = error;
		}
		expect(isTsAutocodeError(thrown)).toBe(true);
		expect(thrown).toBeInstanceOf(InvalidSettingsError);
		expect((thrown as Error).message).toBe("must be a positive integer");
		// The underlying ZodError is preserved rather than discarded.
		expect((thrown as Error).cause).toBeDefined();
	});

	it("falls back to a generic message when the schema supplies no issue text", () => {
		const empty = z.custom<number>(() => false, { message: "" });
		expect(() => parseSetting(empty, 1)).toThrow(InvalidSettingsError);
	});

	it("transforms as the schema directs", () => {
		expect(parseSetting(z.string().transform((value) => value.length), "abcd")).toBe(4);
	});
});
