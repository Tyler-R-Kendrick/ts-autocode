import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const astGrep = join(
	dirname(require.resolve("@ast-grep/cli/package.json")),
	process.platform === "win32" ? "ast-grep.exe" : "ast-grep",
);
const codeExtensions = new Set([
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".jsonc",
]);
const languages = new Map([
	[".yaml", "yaml"],
	[".yml", "yaml"],
	[".sh", "bash"],
	[".bash", "bash"],
	[".py", "python"],
	[".css", "css"],
	[".html", "html"],
	[".go", "go"],
	[".rs", "rust"],
	[".java", "java"],
]);
const deferred = /\b(?:TODO|FIXME|HACK|XXX|TBD)\b|parallel-type-allowed:/iu;
const directive =
	/^(?:\/\/\/?\s*|\/\*+!?\s*|#\s*|<!--\s*)(?:@ts-(?:check|nocheck|ignore|expect-error)\b|@(?:jsx|jsxFrag|jsxImportSource|jsxRuntime|vitest-environment)\b|(?:eslint|oxlint|biome|prettier|stylelint)-(?:disable|enable|ignore)\b|(?:istanbul|c8|v8)\s+ignore\b|(?:shellcheck|pyright|ruff|fmt|type|pragma|buf|go|atlas):|yaml-language-server:|noqa\b|[#@]__(?:PURE|NO_SIDE_EFFECTS)__|[#@]\s*sourceMappingURL=|<reference\b|@license\b|SPDX-License-Identifier:|copyright\b)/iu;
const typescriptDirective =
	/^(?:\/\/\/?\s*|\/\*+!?\s*(?:\*\s*)?)@ts-(?:check|nocheck|ignore|expect-error)\b/iu;
const conciseTypescriptDirective =
	/^\/\/\s*@ts-(?:check|nocheck|ignore|expect-error)\s*$/iu;
const lintDirectiveExplanation =
	/^(?:\/\/\/?\s*|\/\*+!?\s*(?:\*\s*)?|#\s*|<!--\s*)(?:eslint|oxlint|stylelint)-(?:disable|enable)\b[^\r\n]*\s--(?:\s|$)/iu;
const generated = /^(?:\/\/\s*@generated\s*|\/\*\s*@generated\s*\*\/)$/u;

function git(args) {
	return execFileSync("git", ["--literal-pathspecs", ...args], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function sourcePath(file) {
	return file.replace(/(?:\.tpl)+$/iu, "");
}

export function commentsIn(file, text) {
	const kind = /\.[jt]sx$/iu.test(sourcePath(file))
		? ts.ScriptKind.TSX
		: ts.ScriptKind.TS;
	const source = ts.createSourceFile(
		file,
		text,
		ts.ScriptTarget.Latest,
		true,
		kind,
	);
	const found = new Map();
	function visit(node) {
		if (ts.isJSDoc(node)) {
			const start = node.getStart(source);
			const end = node.getEnd();
			found.set(start, { start, end, text: text.slice(start, end) });
			return;
		}
		const children = node.getChildren(source);
		if (children.length) {
			for (const child of children) visit(child);
			return;
		}
		const start = node.getFullStart();
		const end = node.getStart(source);
		for (const scan of [
			ts.getLeadingCommentRanges,
			ts.getTrailingCommentRanges,
		]) {
			for (const range of scan(text, start) ?? []) {
				if (range.pos >= start && range.end <= end) {
					found.set(range.pos, {
						start: range.pos,
						end: range.end,
						text: text.slice(range.pos, range.end),
					});
				}
			}
		}
	}
	visit(source);
	return [...found.values()].sort((left, right) => left.start - right.start);
}

function commentLocations(file, text) {
	const extension = extname(sourcePath(file)).toLowerCase();
	const language =
		languages.get(extension) ??
		(file.endsWith("Dockerfile") ||
		(text.startsWith("#!") && !codeExtensions.has(extension))
			? "bash"
			: undefined);
	if (!language) {
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
		return commentsIn(file, text).map((comment) => ({
			text: comment.text,
			first: source.getLineAndCharacterOfPosition(comment.start).line + 1,
			last: source.getLineAndCharacterOfPosition(comment.end - 1).line + 1,
		}));
	}
	const kinds = ["rust", "java"].includes(language)
		? ["line_comment", "block_comment"]
		: ["comment"];
	return kinds.flatMap((kind) => {
		const result = spawnSync(
			astGrep,
			["run", "--stdin", "--lang", language, "--kind", kind, "--json"],
			{
				input: text,
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024,
			},
		);
		if (result.error || (result.status !== 0 && result.status !== 1)) {
			throw new Error(
				`cannot parse ${file}: ${result.error?.message ?? result.stderr}`,
			);
		}
		return JSON.parse(result.stdout).map((match) => ({
			text: match.text,
			first: match.range.start.line + 1,
			last: match.range.end.line + (match.range.end.column === 0 ? 0 : 1),
		}));
	});
}

export function commentViolations(file, text, added) {
	return commentLocations(file, text).flatMap(
		({ first, last, text: comment }) => {
			if (![...added].some((line) => line >= first && line <= last)) return [];
			if (first === 1 && comment.startsWith("#!")) return [];
			if (
				!deferred.test(comment) &&
				(!typescriptDirective.test(comment) ||
					conciseTypescriptDirective.test(comment)) &&
				!lintDirectiveExplanation.test(comment) &&
				(directive.test(comment) || generated.test(comment))
			)
				return [];
			return [
				{
					file,
					line: first,
					message: deferred.test(comment)
						? "finish deferred work instead of adding a marker"
						: "make the code self-documenting instead of adding a comment",
				},
			];
		},
	);
}

export function documentViolation(file, text) {
	const path = sourcePath(file);
	if (
		/(?:^|\/)\.(?:sdlc|impeccable)\//iu.test(path) ||
		/(?:^|\/)\.optimizexp\/(?:backlog\/|personas\/|runs\/)/iu.test(path)
	)
		return true;
	if (!/\.mdx?$/iu.test(path)) return false;
	if (/(?:^|\/)(?:design|designs|architecture|architectures|plans|roadmaps|adr|adrs)\//iu.test(path))
		return true;
	if (/(?:^|\/)anti-slop\/audit[^/]*\.mdx?$/iu.test(path)) return true;
	if (
		/(?:^|\/)(?:design|architecture|roadmap|adr|(?:implementation[-_])?plan)\.mdx?$/iu.test(
			path,
		) ||
		/(?:^|\/)[^/]+[-_](?:design|architecture|roadmap|plan)\.mdx?$/iu.test(path)
	)
		return true;
	const frontmatter =
		/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)?.[1] ?? "";
	return /^\s*type\s*:\s*[^\n]*\b(?:plan|design|roadmap)\b/imu.test(
		frontmatter,
	);
}

export function addedLineNumbers(patch) {
	const added = new Set();
	let line;
	for (const text of patch.split("\n")) {
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
		if (hunk) line = Number(hunk[1]);
		else if (line !== undefined && text.startsWith("+")) added.add(line++);
		else if (line !== undefined && text.startsWith(" ")) line++;
	}
	return added;
}

export function checkSourcePolicy(mode) {
	let args;
	if (mode.kind === "staged") args = ["diff", "--cached"];
	else if (mode.kind === "worktree") args = ["diff", "HEAD"];
	else {
		const commit = git([
			"rev-parse",
			"--verify",
			"--end-of-options",
			`${mode.ref}^{commit}`,
		]).trim();
		args = ["diff", git(["merge-base", commit, "HEAD"]).trim(), "HEAD"];
	}
	const untracked =
		mode.kind === "worktree"
			? [
					...git(["ls-files", "--others", "--exclude-standard", "-z"]).split(
						"\0",
					),
					...execFileSync(
						"git",
						[
							"ls-files",
							"--others",
							"--ignored",
							"--exclude-standard",
							"-z",
							"--",
							":(glob)**/.sdlc/**",
							":(glob)**/.impeccable/**",
							":(glob)**/.optimizexp/**",
						],
						{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
					).split("\0"),
				].filter(Boolean)
			: [];
	const files = [
		...new Set([
			...git([
				...args,
				"--no-renames",
				"--name-only",
				"--diff-filter=ACMRT",
				"-z",
				"--",
			])
				.split("\0")
				.filter(Boolean),
			...untracked,
		]),
	];
	const entries = git(
		mode.kind === "base"
			? ["ls-tree", "-rz", "HEAD"]
			: ["ls-files", "--stage", "-z"],
	);
	const gitlinks = new Set(
		entries
			.split("\0")
			.filter((entry) => entry.startsWith("160000 "))
			.map((entry) => entry.slice(entry.indexOf("\t") + 1)),
	);
	const violations = [];
	for (const file of files) {
		if (
			gitlinks.has(file) ||
			/(?:^|\/)(?:node_modules|dist|_generated)\//u.test(file)
		)
			continue;
		const extension = extname(sourcePath(file)).toLowerCase();
		const document =
			/\.mdx?$/iu.test(sourcePath(file)) ||
			/(?:^|\/)\.(?:sdlc|impeccable|optimizexp)\//iu.test(file);
		const code =
			codeExtensions.has(extension) ||
			languages.has(extension) ||
			file.endsWith("Dockerfile") ||
			extension === "";
		if (!document && !code) continue;
		const text =
			mode.kind === "staged"
				? git(["show", `:${file}`])
				: mode.kind === "base"
					? git(["show", `HEAD:${file}`])
					: readFileSync(file, "utf8");
		if (document && documentViolation(file, text))
			violations.push({
				file,
				line: 1,
				message: "planning and design documents are not allowed",
			});
		if (
			!code ||
			(extension === "" &&
				!file.endsWith("Dockerfile") &&
				!text.startsWith("#!"))
		)
			continue;
		const added = untracked.includes(file)
			? new Set(text.split(/\r?\n/u).map((_, index) => index + 1))
			: addedLineNumbers(
					git([
						...args,
						"--no-renames",
						"--no-color",
						"--no-ext-diff",
						"--unified=0",
						"--",
						file,
					]),
				);
		violations.push(...commentViolations(file, text, added));
	}
	return violations;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const args = process.argv.slice(2);
		const base = args.find((arg) => arg.startsWith("--base="));
		const mode = args.includes("--staged")
			? { kind: "staged" }
			: base
				? { kind: "base", ref: base.slice(7) }
				: { kind: "worktree" };
		const violations = checkSourcePolicy(mode);
		for (const violation of violations)
			process.stderr.write(
				`${violation.file}:${violation.line}: ${violation.message}\n`,
			);
		if (violations.length) process.exitCode = 1;
	} catch (error) {
		process.stderr.write(
			`source policy failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
