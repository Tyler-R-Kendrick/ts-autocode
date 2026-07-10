import { describe, expect, it } from "vitest";

import { findGeneratedRegion } from "../src/index.js";

const source = `export function route(input: string) {
  // autocode:generated-region begin region=router owner=ax
  return input;
  // autocode:generated-region end region=router
}
`;

describe("findGeneratedRegion", () => {
	it("returns the optimizer-owned range and a source digest", () => {
		const region = findGeneratedRegion(source, "router", { artifactRef: "src/router.ts" });

		expect(source.slice(region.startOffset, region.endOffset)).toBe("  return input;\n");
		expect(region).toMatchObject({
			artifactRef: "src/router.ts",
			owner: "ax",
			regionId: "router",
		});
		expect(region.sourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
	});

	it("supports an existing marker convention", () => {
		const custom = source.replaceAll("autocode:generated-region", "hobo:generated-region");
		expect(findGeneratedRegion(custom, "router", { markerPrefix: "hobo:generated-region" }).regionId).toBe(
			"router",
		);
	});

	it("rejects missing and unclosed regions", () => {
		expect(() => findGeneratedRegion("const value = 1;", "router")).toThrow("was not found");
		expect(() => findGeneratedRegion(source.replace("// autocode:generated-region end region=router", ""), "router"))
			.toThrow("is not closed");
	});
});
