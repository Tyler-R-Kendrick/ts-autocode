import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";


const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

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
