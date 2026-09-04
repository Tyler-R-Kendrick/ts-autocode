import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Which files count as this repository's documentation.
//
// `test/docs.test.ts` (snippets compile) and `test/adr.test.ts` (no snippet
// teaches the banned identity form) both worked from a hand-maintained list,
// and both lists had drifted: `AGENTS.md` -- the file that *states* the
// identity ADR, and carries the snippet demonstrating it -- was in neither, so
// the document defining the rule was exempt from the check enforcing it.
// `docs/dx-review.md` and `docs/testing.md` were missing too.
//
// Discovery instead of a list, because a list is a thing to forget. Scoped
// rather than every `**/*.md`: `.claude/skills/` vendors another library's
// documentation and `.agentv/` holds run output, neither of which this repo
// gets to make claims about.

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Repo-relative paths of every document this repository publishes. */
export function documentationFiles(): readonly string[] {
	return [
		...markdownIn("."),
		...markdownIn("docs"),
		...readdirSync(join(repoRoot, "packages"), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => `packages/${entry.name}/README.md`)
			.filter((doc) => existsSync(join(repoRoot, doc))),
	].sort();
}

/** Reads a document, naming it when it is unreadable. An unguarded read throws
 * at module load, which takes down the whole suite instead of failing one case
 * that says which file it wanted. */
export function readDoc(doc: string): string {
	try {
		return readFileSync(join(repoRoot, doc), "utf8");
	} catch (error) {
		throw new Error(`documentation file is unreadable: ${doc}`, { cause: error });
	}
}

function markdownIn(directory: string): string[] {
	return readdirSync(join(repoRoot, directory), { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => directory === "." ? entry.name : `${directory}/${entry.name}`);
}
