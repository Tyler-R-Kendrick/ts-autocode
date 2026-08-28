import { describe, expect, it } from "vitest";

import { digest as rewriteDigest } from "ts-autocode-rewrite";
import { textDigest } from "ts-autocode-grounding";

import { digest as trainingDigest } from "../packages/training/src/digest.js";

// Body digests are the shared protocol between training and rewrite: guarded
// application refuses a candidate whose target body digest no longer matches,
// so the two packages must hash identical content to identical values. They are
// separate implementations by design (neither package imports the other), which
// is exactly why the agreement needs a test rather than an assumption. This
// lives at the root because it is the only place both packages are importable.


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
		// Same `sha256:` prefix, different algorithm -- swapping them silently
		// changes every hash, which is why it was renamed `textDigest`.
		expect(textDigest("a\nb")).not.toBe(rewriteDigest("a\nb"));
		// And it normalizes line endings, which the value digest does not.
		expect(textDigest("a\r\nb")).toBe(textDigest("a\nb"));
		expect(rewriteDigest("a\r\nb")).not.toBe(rewriteDigest("a\nb"));
	});
});
