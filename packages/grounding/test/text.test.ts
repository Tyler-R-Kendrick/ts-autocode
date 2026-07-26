import { describe, expect, it } from "vitest";

import { camelCase, digest, normalizeText, pascalCase, stableStringify, union } from "../src/index.js";

// Golden values pinned so downstream byte-for-byte digest parity
// (e.g. HoBo's build-digest-parity suite) survives refactors here.
describe("text helpers", () => {
	it("digest is stable across whitespace normalization", () => {
		expect(digest("")).toBe("sha256:01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b");
		expect(digest("hello world")).toBe("sha256:a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447");
		expect(digest("a\r\n b \n")).toBe("sha256:f4f84306f6f4eccf2a1daff1aa505ddf034dc048aa546786978aa0612f580c15");
		expect(digest("hello world\n")).toBe(digest("hello world"));
	});

	it("normalizeText produces LF-only output with one final newline", () => {
		expect(normalizeText("a\r\nb\t \nc  \n\n")).toBe("a\nb\nc\n");
	});

	it("stableStringify sorts keys, arrays, sets, and maps deterministically", () => {
		expect(stableStringify({ b: 1, a: [2, 1] })).toBe('{\n  "a": [\n    1,\n    2\n  ],\n  "b": 1\n}\n');
		expect(stableStringify(new Map([["z", 1], ["a", 2]]))).toBe(stableStringify({ a: 2, z: 1 }));
		expect(stableStringify(new Set(["b", "a"]))).toBe(stableStringify(["a", "b"]));
	});

	it("cases and unions", () => {
		expect(pascalCase("hello-world_thing")).toBe("HelloWorldThing");
		expect(camelCase("Hello-world_thing")).toBe("helloWorldThing");
		expect(union(["b", "a"])).toBe('"a" | "b"');
		expect(union([])).toBe("never");
	});
});
