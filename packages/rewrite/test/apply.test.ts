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

describe("body reindentation", () => {
	// Mutation testing left 15 survivors in `formatImplementation`: the whole
	// indent-detection and normalization block could be broken without any test
	// noticing, because the existing cases all used a single tab style and a
	// single-line body. Reindentation is what keeps a rewritten file readable
	// and diff-able, so it deserves cases that pin each decision.
	/** Offsets exactly as source discovery computes them: `bodyEnd` is the index
	 * of the method's closing brace, not the newline before it. Getting this
	 * wrong produces a stray blank line and looks like a library bug. */
	function rewriteWith(source: string, implementation: string, indent = "  "): string {
		const bodyStart = source.indexOf('"use audit";') + '"use audit";'.length;
		const closing = `\n${indent}}`;
		const bodyEnd = source.lastIndexOf(closing) + closing.length - 1;
		const target: RewriteTarget = {
			id: "T.m",
			artifactRef: "memory://t.ts",
			bodyStart,
			bodyEnd,
			bodyDigest: digest(source.slice(bodyStart, bodyEnd)),
			indentation: indent,
		};
		const candidate: RewriteCandidate = { id: "reindent", target, implementation };
		return applyCandidate(source, candidate);
	}

	const spaceSource = 'class T {\n  m(): string {\n    "use audit";\n    return "a";\n  }\n}\n';

	it("indents a single-line body one level past the method", () => {
		const result = rewriteWith(spaceSource, 'return "b";');
		expect(result).toContain('\n    return "b";\n  }');
	});

	it("keeps relative indentation inside a multi-line body", () => {
		const result = rewriteWith(spaceSource, 'if (x) {\n  return "b";\n}');
		expect(result).toContain('\n    if (x) {\n      return "b";\n    }\n  }');
	});

	it("strips a uniform leading indent the engine happened to include", () => {
		// An engine often returns an already-indented body; the common prefix is
		// removed so it is not indented twice.
		const result = rewriteWith(spaceSource, '        return "b";');
		expect(result).toContain('\n    return "b";\n  }');
	});

	it("uses tabs when the method itself is tab-indented", () => {
		const tabSource = 'class T {\n\tm(): string {\n\t\t"use audit";\n\t\treturn "a";\n\t}\n}\n';
		const result = rewriteWith(tabSource, 'return "b";', "\t");
		expect(result).toContain('\n\t\treturn "b";\n\t}');
		expect(result).not.toContain('  return "b";');
	});

	it("preserves blank lines inside the body, and leaves them empty", () => {
		// Indenting a blank line would write trailing whitespace into the user's
		// source file, which their own lint step then rejects.
		const result = rewriteWith(spaceSource, 'const a = 1;\n\nreturn "b";');
		expect(result).toContain('\n    const a = 1;\n\n    return "b";\n  }');
		expect(result).not.toMatch(/[ \t]+\n/);
	});

	it("handles a body that is only whitespace without collapsing the method", () => {
		const result = rewriteWith(spaceSource, "   ");
		expect(result).toContain("class T {");
		expect(result.endsWith("}\n")).toBe(true);
	});

	// The mutants that survived the previous round all lived in the de-dent:
	// every case above uses either a single-line body or a multi-line one with
	// no leading indent, so `Math.min` returned 0 whatever the filter did. A
	// model returns indented, blank-line-separated code, which is exactly the
	// shape that tells the decisions apart.
	it("measures the de-dent from the code lines, ignoring the blank ones between them", () => {
		// Every code line is indented four; dropping the blank-line filter would
		// measure zero and leave the whole body double-indented.
		const result = rewriteWith(spaceSource, '    const a = 1;\n\n    return "b";');
		expect(result).toContain('\n    const a = 1;\n\n    return "b";\n  }');
	});

	it("treats a whitespace-only line as blank, not as the shallowest indent", () => {
		// The separator here is two spaces rather than empty. Filtering on the
		// raw line instead of its trimmed form would measure it as an indent of
		// two and de-dent every other line by two instead of four.
		const result = rewriteWith(spaceSource, '    const a = 1;\n  \n    return "b";');
		expect(result).toContain('\n    const a = 1;\n\n    return "b";\n  }');
		expect(result).not.toContain('\n      const a = 1;');
	});

	it("uses tabs when the file is tab-indented even where the method's own indent is not", () => {
		// A method at column zero -- a top-level function, or the first method of
		// a class written flush left -- has no indent of its own to copy, so the
		// file decides. Nothing exercised this arm before: every tab fixture also
		// had a tab-indented method.
		const mixed = 'class T {\n\tother(): void {}\n}\nfunction m(): string {\n  "use audit";\n  return "a";\n}\n';
		const bodyStart = mixed.indexOf('"use audit";') + '"use audit";'.length;
		const closing = "\n}";
		const target: RewriteTarget = {
			id: "m",
			artifactRef: "memory://mixed.ts",
			bodyStart,
			bodyEnd: mixed.lastIndexOf(closing) + closing.length - 1,
			bodyDigest: digest(mixed.slice(bodyStart, mixed.lastIndexOf(closing) + closing.length - 1)),
			indentation: "",
		};
		const result = applyCandidate(mixed, { id: "mixed", target, implementation: 'return "b";' });
		expect(result).toContain('\n\treturn "b";\n}');
	});

	it("always opens with a newline and closes at the method's indent", () => {
		const result = rewriteWith(spaceSource, 'return "b";');
		const bodyStart = result.indexOf('"use audit";') + '"use audit";'.length;
		expect(result[bodyStart]).toBe("\n");
		expect(result).toContain('\n  }');
		// No stray blank line before the closing brace.
		expect(result).not.toContain("\n  \n  }");
	});
});
