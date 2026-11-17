import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { describeTrainables, run, usage } from "../src/cli.js";
import { discoverInSource } from "ts-autocode-training";

const discovery = vi.hoisted(() => ({ crash: undefined as Error | undefined }));

vi.mock("ts-autocode-training", async (importOriginal) => {
	const actual = await importOriginal<typeof import("ts-autocode-training")>();
	return {
		...actual,
		discoverTrainables: (settings: Parameters<typeof actual.discoverTrainables>[0]) => {
			if (discovery.crash) throw discovery.crash;
			return actual.discoverTrainables(settings);
		},
	};
});


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

	it("suggests the unique-symbol key flow against a real discovered id", async () => {
		const result = await run(["discover", "--file", await project()]);
		expect(result.stdout).toContain("unique symbol");
		expect(result.stdout).toContain("Mark Router.route with @trainable(route)");
		expect(result.stdout).toContain("pass route to training.train");
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

describe("ts-autocode train", () => {
	async function trainingModule(name: string, implementation: string) {
		const sourceFile = resolve(await project());
		const moduleFile = resolve(directory, `${name}.mjs`);
		const outputDir = resolve(directory, `${name}-output`);
		await writeFile(moduleFile, `
import { createTrainingRuntime, directExecutor, instrumentTrainable, rewritePromotion, sequentialLoop } from "ts-autocode";
class Router { route(input) { return input; } }
const route = Symbol("route");
instrumentTrainable(Router, "route", route);
const runtime = createTrainingRuntime({
  engine: () => ${JSON.stringify(implementation)},
  executor: directExecutor,
  source: { files: [${JSON.stringify(sourceFile)}] },
  tracing: { enabled: false },
  loop: sequentialLoop,
  promote: rewritePromotion,
});
export const request = {
  trainable: route,
  runtime,
  input: { cases: [["abc", "ABC"]], rounds: { max: 1 }, evaluation: { outputDir: ${JSON.stringify(outputDir)} } },
};
export default request;
`, "utf8");
		return { sourceFile, moduleFile };
	}

	it("trains a symbol-keyed method without applying the candidate", async () => {
		const { sourceFile } = await trainingModule("ready", "return input.toUpperCase();");
		const original = await readFile(sourceFile, "utf8");
		const result = await run(["train", "--cwd", resolve(directory), "--module", "ready.mjs", "--export", "request", "--output-dir", "chosen-output", "--json"]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "ready", readiness: { ready: true }, activated: false });
		expect(await readFile(sourceFile, "utf8")).toBe(original);
		expect(await readFile(resolve(directory, "chosen-output/benchmark.json"), "utf8")).toContain("case-1");
	}, 30_000);

	it("applies an accepted candidate only when requested", async () => {
		const { sourceFile, moduleFile } = await trainingModule("activate", "return input.toUpperCase();");
		const result = await run(["train", "--module", moduleFile, "--activate"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Activated: yes");
		expect(await readFile(sourceFile, "utf8")).toContain("return input.toUpperCase();");
	}, 30_000);

	it("does not apply a candidate rejected by evaluation", async () => {
		const { sourceFile, moduleFile } = await trainingModule("rejected", 'return "wrong";');
		const original = await readFile(sourceFile, "utf8");
		const result = await run(["train", "--module", moduleFile, "--activate", "--json"]);
		expect(result.code).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({ readiness: { ready: false }, activated: false });
		expect(await readFile(sourceFile, "utf8")).toBe(original);
		const text = await run(["train", "--module", moduleFile]);
		expect(text.code).toBe(1);
		expect(text.stdout).toContain("Ready to activate: no");
	}, 30_000);

	it("rejects missing modules, invalid identities, and misplaced options", async () => {
		expect((await run(["train"])).stderr).toContain("requires --module");
		expect((await run(["train", "--module", "missing.mjs"])).stderr).toContain("cannot load training module");
		await mkdir(directory, { recursive: true });
		const invalid = resolve(directory, "invalid.mjs");
		await writeFile(invalid, `
export default { trainable: "Router.route" };
export const missingIdentity = {};
export const badRuntime = { trainable: Symbol(), runtime: {} };
export const badInput = { trainable: Symbol(), input: [] };
export const nestedIdentity = { trainable: Symbol(), input: { trainable: Symbol() } };
export const unregistered = { trainable: Symbol() };
`, "utf8");
		expect((await run(["train", "--module", invalid])).stderr).toContain("trainable must be a symbol");
		expect((await run(["train", "--module", invalid, "--export", "missing"])).code).toBe(2);
		for (const name of ["missingIdentity", "badRuntime", "badInput", "nestedIdentity"]) {
			expect((await run(["train", "--module", invalid, "--export", name])).code).toBe(2);
		}
		expect((await run(["train", "--module", invalid, "--export", "unregistered"])).code).toBe(1);
		expect((await run(["train", "--module", invalid, "--export", ""])).code).toBe(2);
		expect((await run(["train", "--module", invalid, "--file", "router.ts"])).code).toBe(2);
		expect((await run(["discover", "--module", invalid])).code).toBe(2);
	});
});

describe("ts-autocode status", () => {
	it("reports zero captures before an app has served traffic", async () => {
		const result = await run(["status", "--file", await project(), "--output-dir", `${directory}/absent`]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("0 successful / 0 captured");
	});

	it("renders the counts as a table when --json is not asked for", async () => {
		const artifacts = join(directory, "table-artifacts");
		await rm(artifacts, { recursive: true, force: true });
		await mkdir(artifacts, { recursive: true });
		await writeFile(join(artifacts, "records.json"), JSON.stringify([
			{ trainableId: "Router.route", succeeded: true },
			{ trainableId: "Router.route", succeeded: true },
			{ trainableId: "Router.route", succeeded: false },
		]), "utf8");
		const result = await run(["status", "--file", await project(), "--output-dir", artifacts]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Router.route   2 successful / 3 captured");
		expect(result.stdout).toContain("Router.enrich  0 successful / 0 captured");
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

	describe("a failure the library does not model", () => {
		afterEach(() => { discovery.crash = undefined; });

		it.each(["discover", "status"])("propagates out of %s rather than becoming an exit code", async (command) => {
			discovery.crash = new TypeError("something the library does not model");
			await expect(run([command, "--file", await project()]))
				.rejects.toThrow("something the library does not model");
		});
	});
});

describe("ts-autocode status output paths", () => {
	it("reports no trainables in table form when the project marks none", async () => {
		await mkdir(directory, { recursive: true });
		const empty = join(directory, "nothing.ts");
		await writeFile(empty, "export const x = 1;\n", "utf8");
		const result = await run(["status", "--file", empty]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("No trainables found.");
	});

	it("reports zero for a trainable that has no records at all", async () => {
		const artifacts = join(directory, "empty-artifacts");
		await mkdir(artifacts, { recursive: true });
		await writeFile(join(artifacts, "records.json"), "[]", "utf8");
		const result = await run(["status", "--file", await project(), "--output-dir", artifacts]);
		expect(result.stdout).toMatch(/Router\.route\s+0 successful \/ 0 captured/);
	});

	it("ignores a malformed records file rather than crashing", async () => {
		const artifacts = join(directory, "bad-artifacts");
		await mkdir(artifacts, { recursive: true });
		await writeFile(join(artifacts, "records.json"), "{ not json", "utf8");
		const result = await run(["status", "--file", await project(), "--output-dir", artifacts]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("0 successful / 0 captured");
	});

	it("ignores a records file that is valid JSON but not an array", async () => {
		const artifacts = join(directory, "object-artifacts");
		await mkdir(artifacts, { recursive: true });
		await writeFile(join(artifacts, "records.json"), '{"trainableId":"Router.route"}', "utf8");
		expect((await run(["status", "--file", await project(), "--output-dir", artifacts])).code).toBe(0);
	});

	it("counts records for trainables the project no longer declares", async () => {
		const artifacts = join(directory, "stale-artifacts");
		await mkdir(artifacts, { recursive: true });
		await writeFile(join(artifacts, "records.json"), JSON.stringify([
			{ trainableId: "Gone.method", succeeded: true },
			{ trainableId: "Router.route", succeeded: true },
		]), "utf8");
		const result = await run(["status", "--file", await project(), "--output-dir", artifacts, "--json"]);
		expect(JSON.parse(result.stdout)).toEqual([
			{ id: "Router.route", captured: 1, succeeded: 1 },
			{ id: "Router.enrich", captured: 0, succeeded: 0 },
		]);
	});
});

describe("ts-autocode option handling", () => {
	it("accepts repeated --file", async () => {
		await mkdir(directory, { recursive: true });
		const second = join(directory, "second.ts");
		await writeFile(second, 'class Other {\n\tgo(): string {\n\t\t"use training";\n\t\treturn "x";\n\t}\n}\n', "utf8");
		const result = await run(["discover", "--file", await project(), "--file", second, "--json"]);
		const rows = JSON.parse(result.stdout) as Array<{ id: string }>;
		expect(rows.map((row) => row.id)).toContain("Other.go");
	});

	it("resolves --file relative to --cwd", async () => {
		await project();
		const result = await run(["discover", "--cwd", directory, "--file", "router.ts", "--json"]);
		expect((JSON.parse(result.stdout) as unknown[]).length).toBe(2);
	});

	it("reports paths relative to the working directory", async () => {
		const result = await run(["discover", "--cwd", directory, "--file", "router.ts", "--json"]);
		const rows = JSON.parse(result.stdout) as Array<{ location: string }>;
		expect(rows[0]?.location).toBe("router.ts");
	});
});
