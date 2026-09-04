import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { digest as rewriteDigest } from "ts-autocode-rewrite";
import { textDigest } from "ts-autocode-grounding";
import {
	defined,
	defineTrainable,
	evaluationArgs,
	evaluatePromotionGate,
	optional,
	toTrainableToken,
	trainableTokenFromSymbol,
	type BoundEvaluation,
	type CandidatePatch,
} from "../src/index.js";
import { discoverInSource } from "../src/index.js";
import { trainableIdFromKey } from "../packages/training/src/token.js";

// Property-based tests: instead of a handful of chosen inputs, state the law
// that must hold and let fast-check hunt for a counterexample. These target the
// pure, total functions where an example-based test can only ever sample --
// identity round-trips, canonicalization, aggregation, and the spread helpers.
//
// Every failure prints a shrunk counterexample and a seed, so a regression is
// reproducible rather than "it failed once on CI".

const runs = 300;

/** Ids the library accepts: non-empty once trimmed. */
const trainableId = fc.string({ minLength: 1, maxLength: 64 })
	.filter((value) => value.trim().length > 0);

describe("trainable identity", () => {
	it("round-trips through its symbol for any acceptable id", () => {
		fc.assert(fc.property(trainableId, (id) => {
			const token = defineTrainable(id);
			expect(trainableTokenFromSymbol(token.symbol).id).toBe(id.trim());
			expect(toTrainableToken(token.symbol)).toEqual(token);
		}), { numRuns: runs });
	});

	it("is idempotent: defining twice yields the same symbol", () => {
		fc.assert(fc.property(trainableId, (id) => {
			expect(defineTrainable(id).symbol).toBe(defineTrainable(id).symbol);
		}), { numRuns: runs });
	});

	it("ignores surrounding whitespace but nothing else", () => {
		fc.assert(fc.property(trainableId, fc.stringMatching(/^[ \t\n]*$/), (id, pad) => {
			expect(defineTrainable(`${pad}${id}${pad}`).id).toBe(id.trim());
		}), { numRuns: runs });
	});

	it("distinct trimmed ids never collide", () => {
		fc.assert(fc.property(trainableId, trainableId, (left, right) => {
			fc.pre(left.trim() !== right.trim());
			expect(defineTrainable(left).symbol).not.toBe(defineTrainable(right).symbol);
		}), { numRuns: runs });
	});

	it("stripping the key prefix is idempotent for unprefixed keys", () => {
		fc.assert(fc.property(fc.string(), (key) => {
			fc.pre(!key.startsWith("ts-autocode.trainable:"));
			expect(trainableIdFromKey(key)).toBe(key);
		}), { numRuns: runs });
	});

	it("rejects every blank id rather than producing an empty identity", () => {
		fc.assert(fc.property(fc.stringMatching(/^[ \t\n\r]*$/), (blank) => {
			expect(() => defineTrainable(blank)).toThrow();
		}), { numRuns: runs });
	});
});

describe("digest canonicalization", () => {
	// Guarded rewriting refuses a candidate whose body digest changed, so these
	// laws are load-bearing rather than cosmetic.
	const json = fc.jsonValue();

	it("is deterministic", () => {
		fc.assert(fc.property(json, (value) => {
			expect(rewriteDigest(value)).toBe(rewriteDigest(value));
		}), { numRuns: runs });
	});

	it("is insensitive to object key order at any depth", () => {
		fc.assert(fc.property(json, (value) => {
			expect(rewriteDigest(value)).toBe(rewriteDigest(shuffleKeys(value)));
		}), { numRuns: runs });
	});

	it("is sensitive to array order whenever order is observable", () => {
		fc.assert(fc.property(fc.uniqueArray(fc.integer(), { minLength: 2, maxLength: 8 }), (values) => {
			expect(rewriteDigest(values)).not.toBe(rewriteDigest([...values].reverse()));
		}), { numRuns: runs });
	});

	it("always produces the documented shape", () => {
		fc.assert(fc.property(json, (value) => {
			expect(rewriteDigest(value)).toMatch(/^sha256:[0-9a-f]{64}$/);
		}), { numRuns: runs });
	});

	it("text digest normalizes line endings and nothing else", () => {
		fc.assert(fc.property(fc.array(fc.string({ maxLength: 12 }), { maxLength: 8 }), (lines) => {
			expect(textDigest(lines.join("\r\n"))).toBe(textDigest(lines.join("\n")));
		}), { numRuns: runs });
	});
});

describe("optional and defined", () => {
	it("optional includes a key exactly when the value is defined", () => {
		// `Object.hasOwn`, not `in`: `in` walks the prototype chain, so any key
		// named after an Object.prototype member ("toString", "constructor")
		// reads as present whether or not it was added. fast-check found that
		// mistake in this assertion within a few hundred runs.
		fc.assert(fc.property(fc.string({ minLength: 1 }), fc.option(fc.jsonValue(), { nil: undefined }), (key, value) => {
			const spread = { ...optional(key, value) } as Record<string, unknown>;
			expect(Object.hasOwn(spread, key)).toBe(value !== undefined);
		}), { numRuns: runs });
	});

	it("optional is safe for keys that shadow Object.prototype", () => {
		for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
			const present = { ...optional(key, 1) } as Record<string, unknown>;
			expect(Object.hasOwn(present, key)).toBe(true);
			expect(present[key]).toBe(1);
			// A computed `__proto__` defines an own property rather than setting
			// the prototype, so the object stays a plain object.
			expect(Object.getPrototypeOf({ ...optional("__proto__", { polluted: true }) })).toBe(Object.prototype);
			expect(Object.hasOwn({ ...optional(key, undefined) } as object, key)).toBe(false);
		}
	});

	it("defined keeps exactly the defined entries", () => {
		fc.assert(fc.property(
			fc.dictionary(fc.string({ minLength: 1 }), fc.option(fc.integer(), { nil: undefined })),
			(record) => {
				const spread = { ...defined(record) } as Record<string, unknown>;
				const expected = Object.entries(record).filter(([, value]) => value !== undefined).map(([key]) => key);
				expect(Object.keys(spread).sort()).toEqual(expected.sort());
			},
		), { numRuns: runs });
	});

	it("defined never introduces an explicit undefined", () => {
		fc.assert(fc.property(
			fc.dictionary(fc.string({ minLength: 1 }), fc.option(fc.integer(), { nil: undefined })),
			(record) => {
				for (const value of Object.values({ ...defined(record) })) expect(value).toBeDefined();
			},
		), { numRuns: runs });
	});
});

describe("evaluation argument decoding", () => {
	it("never throws, whatever the eval input is", () => {
		fc.assert(fc.property(fc.string(), (input) => {
			expect(Array.isArray(evaluationArgs(input))).toBe(true);
		}), { numRuns: runs });
	});

	it("round-trips a JSON array of arguments", () => {
		// `-0` is excluded because JSON cannot represent it: JSON.stringify(-0)
		// is "0", so no decoder could return it. That is a property of the wire
		// format, not something this library can or should fix, but it is
		// worth having stated, since eval inputs are JSON strings.
		fc.assert(fc.property(fc.array(fc.jsonValue(), { maxLength: 6 }), (args) => {
			fc.pre(!JSON.stringify(args).includes("-0") && !hasNegativeZero(args));
			expect(evaluationArgs(JSON.stringify(args))).toEqual(args);
		}), { numRuns: runs });
	});

	it("cannot recover negative zero, because JSON does not carry it", () => {
		expect(JSON.stringify([-0])).toBe("[0]");
		expect(Object.is(evaluationArgs("[-0]")[0], -0)).toBe(true);
		expect(Object.is(evaluationArgs(JSON.stringify([-0]))[0], -0)).toBe(false);
	});

	it("wraps a non-array JSON value as a single argument", () => {
		fc.assert(fc.property(fc.oneof(fc.integer(), fc.boolean(), fc.constant(null)), (value) => {
			expect(evaluationArgs(JSON.stringify(value))).toEqual([value]);
		}), { numRuns: runs });
	});

	it("falls back to the raw string when the input is not JSON", () => {
		fc.assert(fc.property(fc.string(), (input) => {
			fc.pre(!isJson(input));
			expect(evaluationArgs(input)).toEqual([input]);
		}), { numRuns: runs });
	});
});

describe("promotion gate aggregation", () => {
	const target = discoverInSource(`class F {
	m(input: string): string {
		"use training";
		return input;
	}
}`, "f.ts")[0]!;
	const candidate: CandidatePatch = {
		id: "c", trainableId: target.id, engineId: "prop", target, implementation: "return input;",
	};
	const score = fc.float({ min: 0, max: 1, noNaN: true });

	const evaluationsOf = (scores: readonly number[]): BoundEvaluation[] => scores.map((value, index) => ({
		trainableId: target.id,
		candidateId: candidate.id,
		result: { testId: `t${index}`, score: value, executionStatus: "ok", output: "" } as never,
	}));

	it("mean score is the arithmetic mean of the bound results", async () => {
		await fc.assert(fc.asyncProperty(fc.array(score, { minLength: 1, maxLength: 8 }), async (scores) => {
			const decision = await evaluatePromotionGate({
				candidate, evaluations: evaluationsOf(scores), conformance: true,
			});
			const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
			expect(decision.meanScore).toBeCloseTo(mean, 10);
		}), { numRuns: 100 });
	});

	it("mean score and pass rate stay within the unit interval", async () => {
		await fc.assert(fc.asyncProperty(fc.array(score, { minLength: 1, maxLength: 8 }), async (scores) => {
			const decision = await evaluatePromotionGate({
				candidate, evaluations: evaluationsOf(scores), conformance: true,
			});
			for (const value of [decision.meanScore, decision.passRate]) {
				expect(value).toBeGreaterThanOrEqual(0);
				expect(value).toBeLessThanOrEqual(1);
			}
		}), { numRuns: 100 });
	});

	it("promotes only when it reports no failures, always", async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(score, { maxLength: 6 }), fc.boolean(), score, score,
			async (scores, conformance, minScore, minPassRate) => {
				const decision = await evaluatePromotionGate({
					candidate, evaluations: evaluationsOf(scores), conformance, minScore, minPassRate,
				});
				expect(decision.promote).toBe(decision.failures.length === 0);
			},
		), { numRuns: 200 });
	});

	it("an extra gate that always refuses always blocks promotion", async () => {
		await fc.assert(fc.asyncProperty(fc.array(score, { minLength: 1, maxLength: 6 }), async (scores) => {
			const decision = await evaluatePromotionGate({
				candidate,
				evaluations: evaluationsOf(scores),
				conformance: true,
				minScore: 0,
				minPassRate: 0,
				gates: [() => "always refuses"],
			});
			expect(decision.promote).toBe(false);
			expect(decision.failures).toContain("always refuses");
		}), { numRuns: 100 });
	});

	it("rejects a threshold outside the unit interval rather than clamping it", async () => {
		await fc.assert(fc.asyncProperty(
			fc.double({ noNaN: true }).filter((value) => value < 0 || value > 1),
			async (minScore) => {
				await expect(evaluatePromotionGate({
					candidate, evaluations: [], conformance: true, minScore,
				})).rejects.toThrow(/between 0 and 1/);
			},
		), { numRuns: 100 });
	});
});

/** Recursively reorders object keys, leaving arrays and scalars alone. */
function shuffleKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(shuffleKeys);
	if (typeof value !== "object" || value === null) return value;
	const entries = Object.entries(value as Record<string, unknown>).reverse();
	return Object.fromEntries(entries.map(([key, nested]) => [key, shuffleKeys(nested)]));
}

/** True when any nested value is `-0`, which JSON flattens to `0`. */
function hasNegativeZero(value: unknown): boolean {
	if (Object.is(value, -0)) return true;
	if (Array.isArray(value)) return value.some(hasNegativeZero);
	if (typeof value === "object" && value !== null) return Object.values(value).some(hasNegativeZero);
	return false;
}

function isJson(value: string): boolean {
	try {
		JSON.parse(value);
		return true;
	} catch {
		return false;
	}
}
