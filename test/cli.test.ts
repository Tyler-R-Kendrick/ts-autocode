import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { describeTrainables, run, usage } from "../src/cli.js";
import { discoverInSource } from "ts-autocode-training";

// Inspecting what is trainable required writing a script that imports
// discoverTrainables. That matters more here than in most libraries, because
// the identity a user must pass to train() is an exact string with no type
// safety: `defineTrainable("Router.route")`. A typo yields a different symbol
// silently, so `discover` is what makes the marker design usable.

const directory = "test/output/cli";
const source = `class Router {
	route(input: string): string {
		"use training";
		return input;
	}

	async enrich(id: string, deep?: boolean): Promise<string> {
		"use training";
		return \`\${id}:\${deep}\`;
	}
}
`;

async function project(): Promise<string> {
	await mkdir(directory, { recursive: true });
	const file = join(directory, "router.ts");
	await writeFile(file, source, "utf8");
	return file;
}

describe("ts-autocode discover", () => {
	it("lists every marked method with its identity and signature", async () => {
		const result = await run(["discover", "--file", await project()]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Router.route");
		expect(result.stdout).toContain("Router.enrich");
		expect(result.stdout).toContain("route(input: string): string");
		expect(result.stdout).toContain("2 trainables.");
	});

	it("suggests a defineTrainable call using a real discovered id", async () => {
		const result = await run(["discover", "--file", await project()]);
		// The suggested snippet is the payoff: it removes the guesswork from the
		// one stringly-typed seam in an otherwise type-safe design.
		expect(result.stdout).toContain('defineTrainable("Router.route")');
	});

	it("emits machine-readable output", async () => {
		const result = await run(["discover", "--file", await project(), "--json"]);
		const rows = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ id: "Router.route", async: false });
		expect(rows[1]).toMatchObject({ id: "Router.enrich", async: true });
	});

	it("says so plainly when a project marks nothing", async () => {
		await mkdir(directory, { recursive: true });
		const empty = join(directory, "empty.ts");
		await writeFile(empty, "export const nothing = 1;\n", "utf8");
		const result = await run(["discover", "--file", empty]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("No trainables found");
	});

	it("reports the signature and asyncness the engine will see", () => {
		const rows = describeTrainables(discoverInSource(source, "router.ts"), ".");
		expect(rows.map((row) => row.id)).toEqual(["Router.route", "Router.enrich"]);
		expect(rows[1]?.signature).toBe("enrich(id: string, deep?: boolean): Promise<string>");
	});
});

describe("ts-autocode status", () => {
	it("reports zero captures before an app has served traffic", async () => {
		const result = await run(["status", "--file", await project(), "--output-dir", `${directory}/absent`]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("0 successful / 0 captured");
	});

	it("counts captured traces per trainable", async () => {
		const artifacts = join(directory, "artifacts");
		await rm(artifacts, { recursive: true, force: true });
		await mkdir(artifacts, { recursive: true });
		await writeFile(join(artifacts, "records.json"), JSON.stringify([
			{ trainableId: "Router.route", succeeded: true },
			{ trainableId: "Router.route", succeeded: false },
			{ trainableId: "Router.enrich", succeeded: true },
		]), "utf8");
		const result = await run(["status", "--file", await project(), "--output-dir", artifacts, "--json"]);
		expect(JSON.parse(result.stdout)).toEqual([
			{ id: "Router.route", captured: 2, succeeded: 1 },
			{ id: "Router.enrich", captured: 1, succeeded: 1 },
		]);
	});
});

describe("ts-autocode argument handling", () => {
	it("prints usage and fails when given no command", async () => {
		const result = await run([]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("ts-autocode <command>");
	});

	it("prints usage successfully when asked", async () => {
		expect(await run(["help"])).toMatchObject({ code: 0, stdout: usage });
		expect((await run(["--help"])).code).toBe(0);
	});

	it("rejects an unknown command and an unknown flag", async () => {
		expect((await run(["frobnicate"])).stderr).toContain("unknown command: frobnicate");
		expect((await run(["discover", "--nope"])).code).toBe(2);
	});

	it("reports a library failure without a stack trace", async () => {
		const result = await run(["discover", "--project", "no-such-tsconfig.json"]);
		expect(result.code).toBe(1);
		expect(result.stderr).not.toContain("    at ");
	});
});
