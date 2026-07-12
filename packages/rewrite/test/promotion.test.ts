import { describe, expect, it } from "vitest";

import {
	applyCandidate,
	digest,
	promoteCandidate,
	revertPromotion,
	type RewriteCandidate,
	type RewriteTarget,
} from "../src/index.js";

const source = `class Router {
  route(input: string): string {
    "use training";
    return input;
  }
}`;

function targetFor(text: string): RewriteTarget {
	const bodyStart = text.indexOf('"use training";') + '"use training";'.length;
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
	return { id: "candidate-1", trainableId: "Router.route", target: targetFor(text), implementation };
}

describe("guarded source rewrite", () => {
	it("replaces exactly the discovered body and preserves the directive", () => {
		const updated = applyCandidate(source, candidateFor(source, "return input.toUpperCase();"));
		expect(updated).toContain('"use training";');
		expect(updated).toContain("return input.toUpperCase();");
		expect(updated).not.toContain("return input;\n  }");
	});

	it("refuses stale targets whose body changed after discovery", () => {
		const candidate = candidateFor(source, "return input.toUpperCase();");
		const drifted = source.replace("return input;", "return input.trim();");
		expect(() => applyCandidate(drifted, candidate)).toThrow("changed after optimization started");
	});

	it("promotes only gate-approved candidates and records a revertible snapshot", () => {
		const candidate = candidateFor(source, "return input.toUpperCase();");
		expect(() => promoteCandidate({ source, candidate, decision: { candidateId: candidate.id, promote: false } }))
			.toThrow("has not passed the promotion gate");
		expect(() => promoteCandidate({ source, candidate, decision: { candidateId: "other", promote: true } }))
			.toThrow("has not passed the promotion gate");

		const promoted = promoteCandidate({ source, candidate, decision: { candidateId: candidate.id, promote: true } });
		expect(promoted.snapshot.trainableId).toBe("Router.route");
		expect(revertPromotion(promoted.source, promoted.snapshot)).toBe(source);
	});

	it("refuses to revert over subsequent edits", () => {
		const candidate = candidateFor(source, "return input.toUpperCase();");
		const promoted = promoteCandidate({ source, candidate, decision: { candidateId: candidate.id, promote: true } });
		const edited = promoted.source.replace("toUpperCase", "toLowerCase");
		expect(() => revertPromotion(edited, promoted.snapshot)).toThrow("changed before revert");
	});
});
