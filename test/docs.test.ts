import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { documentationFiles, readDoc } from "./support/docs.js";


const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const docs = documentationFiles();

interface Snippet {
	readonly doc: string;
	readonly line: number;
	readonly code: string;
}

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

const snippets = docs.flatMap((doc) => typescriptSnippets(doc, readDoc(doc)));

const directory = join(repoRoot, "test", "output", "docs");

const compilerOptions: ts.CompilerOptions = {
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
	paths: {
		"ts-autocode": ["src/index.ts"],
		"ts-autocode/ax": ["src/providers/ax.ts"],
		"ts-autocode/internal": ["src/internal.ts"],
		"ts-autocode/grounding": ["src/grounding.ts"],
	},
};

function snippetPath(snippet: Snippet): string {
	return join(directory, `snippet-${snippet.doc.replace(/\W/g, "_")}-${snippet.line}.ts`);
}

function describeDiagnostic(diagnostic: ts.Diagnostic): string {
	const line = diagnostic.file && diagnostic.start !== undefined
		? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1
		: 0;
	return `line ${line}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
}

const diagnosticsBySnippet = new Map<string, readonly string[]>();

beforeAll(async () => {
	await rm(directory, { recursive: true, force: true });
	await mkdir(directory, { recursive: true });
	const files = await Promise.all(snippets.map(async (snippet) => {
		const file = snippetPath(snippet);
		await writeFile(file, snippet.code, "utf8");
		return file;
	}));
	const program = ts.createProgram(files, compilerOptions);
	for (const file of files) diagnosticsBySnippet.set(file, []);
	for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
		const name = diagnostic.file?.fileName;
		if (name === undefined) continue;
		const key = files.find((file) => file.replace(/\\/g, "/") === name);
		if (key === undefined) continue;
		diagnosticsBySnippet.set(key, [...(diagnosticsBySnippet.get(key) ?? []), describeDiagnostic(diagnostic)]);
	}
}, 180_000);

afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("documentation snippets", () => {
	it("finds the documented TypeScript blocks", () => {
		expect(snippets.length).toBeGreaterThan(5);
	});

	it("covers every document the repository publishes, not a list someone maintains", () => {
		expect(docs).toContain("README.md");
		expect(docs).toContain("AGENTS.md");
		expect(docs).toContain("docs/testing.md");
		expect(docs).toContain("packages/training/README.md");
	});

	it("compiles every snippet it found", () => {
		expect(diagnosticsBySnippet.size).toBe(snippets.length);
	});

	it.each(snippets.map((snippet) => [`${snippet.doc}:${snippet.line}`, snippet] as const))(
		"%s compiles",
		(_label, snippet) => {
			expect(diagnosticsBySnippet.get(snippetPath(snippet))).toEqual([]);
		},
	);
});
