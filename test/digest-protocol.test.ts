import { describe, expect, it } from "vitest";

import { digest as rewriteDigest } from "ts-autocode-rewrite";
import { textDigest } from "ts-autocode-grounding";

import { digest as trainingDigest } from "../packages/training/src/digest.js";



const values: readonly unknown[] = [
	"return input;",
	"",
	{ a: 1, b: [2, { c: 3 }] },
	{ b: [2, { c: 3 }], a: 1 },
	[1, 2, 3],
	null,
	0,
	true,
	{ nested: { deeply: { keys: "sorted" } } },
];

describe("cross-package digest protocol", () => {
	it.each(values.map((value, index) => [index, value] as const))(
		"training and rewrite agree on value %i",
		(_index, value) => {
			expect(rewriteDigest(value)).toBe(trainingDigest(value));
		},
	);

	it("both are insensitive to key order", () => {
		expect(rewriteDigest({ a: 1, b: 2 })).toBe(rewriteDigest({ b: 2, a: 1 }));
		expect(trainingDigest({ a: 1, b: 2 })).toBe(trainingDigest({ b: 2, a: 1 }));
	});

	it("grounding's text digest is deliberately a different function", () => {
		expect(textDigest("a\nb")).not.toBe(rewriteDigest("a\nb"));
		expect(textDigest("a\r\nb")).toBe(textDigest("a\nb"));
		expect(rewriteDigest("a\r\nb")).not.toBe(rewriteDigest("a\nb"));
	});
});
