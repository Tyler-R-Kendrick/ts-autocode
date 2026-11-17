import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	addedLineNumbers,
	commentsIn,
	commentViolations,
	documentViolation,
} from "../scripts/source-policy.mjs";

const script = resolve("scripts/source-policy.mjs");
const scratch = [];
const env = {
	...process.env,
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
};

afterEach(() => {
	for (const directory of scratch.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function git(repo, ...args) {
	return execFileSync("git", ["-C", repo, ...args], {
		encoding: "utf8",
		env,
	}).trim();
}

function fixture() {
	const repo = mkdtempSync(join(tmpdir(), "ts-autocode-policy-"));
	scratch.push(repo);
	git(repo, "init", "--quiet");
	writeFileSync(
		join(repo, "existing.ts"),
		"// existing\nexport const value = 1;\n",
	);
	git(repo, "add", "existing.ts");
	git(
		repo,
		"-c",
		"user.name=fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"--quiet",
		"-m",
		"fixture",
	);
	return repo;
}

function write(repo, file, text) {
	mkdirSync(dirname(join(repo, file)), { recursive: true });
	writeFileSync(join(repo, file), text);
}

function guard(repo, ...args) {
	return spawnSync(process.execPath, [script, ...args], {
		cwd: repo,
		env,
		encoding: "utf8",
	});
}

describe("source policy", () => {
	it("finds comments while preserving strings, regexes, templates, and JSX text", () => {
		const text = [
			'const url = "https://example.test";',
			"const regex = /https?:\\/\\/example/;",
			"const template = `// text`; ",
			"const view = <p>// text{/* actual */}</p>;",
			"const value = 1; // actual",
		].join("\n");
		assert.deepEqual(
			commentsIn("example.tsx", text).map((comment) => comment.text),
			["/* actual */", "// actual"],
		);
	});

	it("allows tool directives and rejects deferred work and explanations", () => {
		const text = [
			"// @ts-expect-error required",
			"// @generated",
			"// eslint-disable-next-line no-alert TODO replace",
			"// explanation",
		].join("\n");
		assert.deepEqual(
			commentViolations("example.ts", text, new Set([1, 2, 3, 4])).map(
				(item) => item.line,
			),
			[3, 4],
		);
		assert.equal(
			commentViolations(
				"example.ts",
				"/* existing\nnew explanation\n*/",
				new Set([2]),
			).length,
			1,
		);
	});

	it("parses shell and YAML comments without mistaking quoted text for comments", () => {
		assert.equal(
			commentViolations(
				"test.sh",
				'printf "%s" "# value"\n# comment\n',
				new Set([1]),
			).length,
			0,
		);
		assert.equal(
			commentViolations(
				"test.sh",
				'printf "%s" "# value"\n# comment\n',
				new Set([2]),
			).length,
			1,
		);
		assert.equal(
			commentViolations(
				"test.yml",
				'value: "# value"\n# comment\n',
				new Set([1]),
			).length,
			0,
		);
		assert.equal(
			commentViolations(
				"test.yml",
				'value: "# value"\n# comment\n',
				new Set([2]),
			).length,
			1,
		);
	});

	it("rejects planning artifacts by path, name, and document type", () => {
		for (const [file, text] of [
			["docs/design/feature.md", "# Feature"],
			["docs/architecture.md", "# Architecture"],
			["anti-slop/audit-001.md", "# Audit"],
			["docs/implementation-plan.md", "# Plan"],
			["notes.md", "---\ntype: implementation plan\n---\n"],
			[".sdlc/work.json", "{}"],
		]) {
			assert.equal(documentViolation(file, text), true, file);
		}
		assert.equal(documentViolation("docs/usage.md", "# Usage"), false);
	});

	it("checks staged content and permits existing comments", () => {
		const repo = fixture();
		write(repo, "existing.ts", "// existing\nexport const value = 2;\n");
		git(repo, "add", "existing.ts");
		assert.equal(guard(repo, "--staged").status, 0);
		write(
			repo,
			"existing.ts",
			"// existing\nexport const value = 2; // explanation\n",
		);
		write(repo, "docs/design/new.md", "# Design\n");
		git(repo, "add", "--all");
		write(repo, "existing.ts", "export const value = 2;\n");
		const result = guard(repo, "--staged");
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /existing\.ts:2/u);
		assert.match(result.stderr, /docs\/design\/new\.md:1/u);
	});

	it("finds ignored agent artifacts in the worktree", () => {
		const repo = fixture();
		write(repo, ".gitignore", ".sdlc/\n");
		write(repo, ".sdlc/plan.md", "# Work\n");
		const result = guard(repo, "--worktree");
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /\.sdlc\/plan\.md/u);
	});

	it("checks all commits since the merge base and rejects unknown bases", () => {
		const repo = fixture();
		const base = git(repo, "rev-parse", "HEAD");
		write(repo, "new.ts", "// explanation\n");
		git(repo, "add", "new.ts");
		git(
			repo,
			"-c",
			"user.name=fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"--quiet",
			"-m",
			"change",
		);
		assert.equal(guard(repo, `--base=${base}`).status, 1);
		assert.equal(guard(repo, "--base=missing").status, 1);
		assert.deepEqual([...addedLineNumbers("@@ -1 +1,2 @@\n old\n+new\n")], [2]);
	});
});
