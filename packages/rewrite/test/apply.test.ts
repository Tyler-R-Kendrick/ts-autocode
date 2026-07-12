import { describe, expect, it } from "vitest";

import {
	applyCandidate,
	commitRewrite,
	digest,
	revertRewrite,
	type RewriteCandidate,
	type RewriteTarget,
} from "../src/index.js";

const source = `class Router {
  route(input: string): string {
    "use audit";
    return input;
  }
}`;

function targetFor(text: string): RewriteTarget {
	const bodyStart = text.indexOf('"use audit";') + '"use audit";'.length;
	const bodyEnd = text.lastIndexOf("\n  }");
	return {
		id: "Router.route",
		artifactRef: "memory://router.ts",
		bodyStart,
		bodyEnd,
		bodyDigest: digest(text.slice(bodyStart, bodyEnd)),
		indentation: "  ",
	};
}

function candidateFor(text: string, implementation: string): RewriteCandidate {
	return { id: "candidate-1", target: targetFor(text), implementation };
}

describe("guarded source rewrite", () => {
	it("replaces exactly the discovered body and preserves the directive", () => {
		const updated = applyCandidate(source, candidateFor(source, "return input.toUpperCase();"));
		expect(updated).toContain('"use audit";');
		expect(updated).toContain("return input.toUpperCase();");
		expect(updated).not.toContain("return input;\n  }");
	});

	it("refuses stale targets whose body changed after discovery", () => {
		const candidate = candidateFor(source, "return input.toUpperCase();");
		const drifted = source.replace("return input;", "return input.trim();");
		expect(() => applyCandidate(drifted, candidate)).toThrow("changed after discovery");
	});

	it("commits a rewrite and records a snapshot that reverts it exactly", () => {
		const candidate = candidateFor(source, "return input.toUpperCase();");
		const committed = commitRewrite(source, candidate);

		expect(committed.snapshot.rewriteId).toBe("candidate-1");
		expect(committed.snapshot.targetId).toBe("Router.route");
		expect(revertRewrite(committed.source, committed.snapshot)).toBe(source);
	});

	it("refuses to revert over subsequent edits", () => {
		const candidate = candidateFor(source, "return input.toUpperCase();");
		const committed = commitRewrite(source, candidate);
		const edited = committed.source.replace("toUpperCase", "toLowerCase");
		expect(() => revertRewrite(edited, committed.snapshot)).toThrow("changed before revert");
	});
});
