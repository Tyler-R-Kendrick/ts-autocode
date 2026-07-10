import { describe, expect, it } from "vitest";

import {
	RegionError,
	applyRegionEdits,
	checkGeneratedRegionDrift,
	findGeneratedRegion,
} from "../src/index.js";
import { classifierRegion, classifierSource } from "./fixtures.js";

describe("findGeneratedRegion", () => {
	it("locates the marker-delimited region and its owner", () => {
		const source = classifierSource();
		const region = findGeneratedRegion(source, "classify-body");

		expect(region.owner).toBe("training-engine");
		expect(source.slice(region.startOffset, region.endOffset)).toBe('  return "identity-support";\n');
	});

	it("throws when the begin marker is missing", () => {
		expect(() => findGeneratedRegion("const x = 1;\n", "classify-body")).toThrowError(RegionError);
		expect(() => findGeneratedRegion("const x = 1;\n", "classify-body")).toThrowError(/region.marker_missing/);
	});

	it("throws when the end marker is missing", () => {
		const source = ["// autocode:generated-region begin region=classify-body owner=training-engine", "code"].join(
			"\n",
		);
		expect(() => findGeneratedRegion(source, "classify-body")).toThrowError(/region.marker_unclosed/);
	});

	it("supports custom marker prefixes for existing codebases", () => {
		const source = classifierSource().replaceAll("autocode:generated-region", "hobo:generated-region");
		const region = findGeneratedRegion(source, "classify-body", { markerPrefix: "hobo:generated-region" });

		expect(source.slice(region.startOffset, region.endOffset)).toBe('  return "identity-support";\n');
	});
});

describe("checkGeneratedRegionDrift", () => {
	it("passes when the generated region is unchanged", () => {
		const report = checkGeneratedRegionDrift({
			source: classifierSource(),
			expectedSource: classifierSource(),
			regionId: "classify-body",
		});

		expect(report.ok).toBe(true);
		expect(report.handWrittenChanged).toBe(false);
	});

	it("flags a hand edit inside the generated region", () => {
		const drifted = classifierSource().replace('"identity-support"', '"hand-edited"');
		const report = checkGeneratedRegionDrift({
			source: drifted,
			expectedSource: classifierSource(),
			regionId: "classify-body",
		});

		expect(report.ok).toBe(false);
		expect(report.code).toBe("region.generated_region_drift");
		expect(report.expectedDigest).not.toBe(report.actualDigest);
	});

	it("reports hand-written changes outside the region without failing", () => {
		const changedOutside = classifierSource().replace("handWrittenGuard = true", "handWrittenGuard = false");
		const report = checkGeneratedRegionDrift({
			source: changedOutside,
			expectedSource: classifierSource(),
			regionId: "classify-body",
		});

		expect(report.ok).toBe(true);
		expect(report.handWrittenChanged).toBe(true);
	});
});

describe("applyRegionEdits", () => {
	it("applies edits right-to-left so offsets stay valid", () => {
		const source = classifierSource();
		const region = classifierRegion(source);
		const next = applyRegionEdits(source, [
			{
				startOffset: region.startOffset,
				endOffset: region.endOffset,
				replacement: '  return "billing-support";\n',
			},
		]);

		expect(next).toContain('return "billing-support";');
		expect(next).toContain("handWrittenGuard = true");
	});
});
