import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The README documented `activation.promotion.snapshot.candidateId` on an
// `Activation` that has only `run` and `rollback`, and a quickstart that
// referenced an undefined `deploymentPolicy`. Prose review had not caught
// either in the year the snippets shipped. Compile them instead.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const docs = [
	"README.md",
	"packages/training/README.md",
	"packages/harness/README.md",
	"packages/rewrite/README.md",
];

interface Snippet {
	readonly doc: string;
	readonly line: number;
	readonly code: string;
}

/** Fenced ```ts blocks, including ones indented inside a list item. A block may
 * opt out with `<!-- typecheck: skip -->` on the line above its fence. */
export function typescriptSnippets(doc: string, markdown: string): readonly Snippet[] {
	const lines = markdown.split("\n");
	const snippets: Snippet[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const open = /^(\s*)```ts$/.exec(lines[index] ?? "");
		if (!open) continue;
		const indent = open[1] ?? "";
		if (/<!--\s*typecheck:\s*skip\s*-->/.test(lines[index - 1] ?? "")) continue;
		const body: string[] = [];
		let cursor = index + 1;
		while (cursor < lines.length && (lines[cursor] ?? "").trim() !== "```") {
			body.push((lines[cursor] ?? "").slice(indent.length));
			cursor += 1;
		}
		snippets.push({ doc, line: index + 1, code: body.join("\n") });
		index = cursor;
	}
	return snippets;
}

const snippets = docs.flatMap((doc) =>
	typescriptSnippets(doc, readFileSync(join(repoRoot, doc), "utf8")));

// Snippets compile inside the repo (under the git-ignored test output tree) so
// NodeNext resolution sees the real node_modules and the root package's
// "type": "module" — top-level await in the docs is then legal, as it is for a
// consumer.
const directory = join(repoRoot, "test", "output", "docs");

beforeAll(async () => {
	await rm(directory, { recursive: true, force: true });
	await mkdir(directory, { recursive: true });
});

afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("documentation snippets", () => {
	it("finds the documented TypeScript blocks", () => {
		expect(snippets.length).toBeGreaterThan(5);
	});

	it.each(snippets.map((snippet) => [`${snippet.doc}:${snippet.line}`, snippet] as const))(
		"%s compiles",
		async (_label, snippet) => {
			// Snippets are top-level-await narratives, so compile each as its own
			// module resolving `ts-autocode` through the repo's real node_modules.
			const file = join(directory, `snippet-${snippet.doc.replace(/\W/g, "_")}-${snippet.line}.ts`);
			await writeFile(file, snippet.code, "utf8");
			const program = ts.createProgram([file], {
				target: ts.ScriptTarget.ES2023,
				module: ts.ModuleKind.NodeNext,
				moduleResolution: ts.ModuleResolutionKind.NodeNext,
				lib: ["lib.es2023.d.ts", "lib.esnext.decorators.d.ts"],
				strict: true,
				noUncheckedIndexedAccess: true,
				exactOptionalPropertyTypes: true,
				noEmit: true,
				skipLibCheck: true,
				types: ["node"],
				baseUrl: repoRoot,
				// The package cannot import itself by name from inside its own
				// repo, so resolve its public entries to their sources — the
				// snippets stay written exactly as a consumer would write them.
				paths: {
					"ts-autocode": ["src/index.ts"],
					"ts-autocode/ax": ["src/providers/ax.ts"],
					"ts-autocode/grounding": ["src/grounding.ts"],
				},
			});
			const errors = ts.getPreEmitDiagnostics(program)
				.filter((diagnostic) => diagnostic.file?.fileName === file.replace(/\\/g, "/"))
				.map((diagnostic) => {
					const position = diagnostic.file && diagnostic.start !== undefined
						? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1
						: 0;
					return `line ${position}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
				});
			expect(errors).toEqual([]);
		},
	);
});
