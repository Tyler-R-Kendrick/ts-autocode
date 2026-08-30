import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { parseArgs } from "node:util";

import {
	defineTrainable,
	discoverTrainables,
	isTsAutocodeError,
	type SourceSettings,
	type TrainableTarget,
	type TrainingRecord,
} from "ts-autocode-training";

// Inspecting what is trainable, what has been captured, or what a run would
// change previously meant writing a script that imports discoverTrainables.
// The identities the library asks for are strings a user has to guess exactly
// -- `defineTrainable("Router.route")` -- so `discover` is the tool that makes
// the marker-based design usable without reading the source scanner.

export const usage = `ts-autocode <command> [options]

Commands:
  discover            List every trainable the TypeScript project marks.
  status              Show captured traces per trainable, read from the
                      records artifact at <output-dir>/records.json. A store
                      must persist that artifact; the default in-memory store
                      does not, so a fresh project reports zero captures.
  help                Show this message.

Options:
  --cwd <dir>         Project root (default: the working directory).
  --project <file>    tsconfig to read (default: tsconfig.json).
  --file <path>       Scan only these files; repeatable.
  --output-dir <dir>  Where run artifacts live (default: .agentv).
  --json              Emit JSON instead of a table.
`;

export interface CliResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

interface DiscoveredRow {
	readonly id: string;
	readonly signature: string;
	readonly location: string;
	readonly async: boolean;
}

/** What `discover` reports, separated from how it is printed so the shape can
 * be tested and consumed as JSON. */
export function describeTrainables(targets: readonly TrainableTarget[], cwd: string): readonly DiscoveredRow[] {
	return targets.map((target) => ({
		id: target.id,
		signature: target.signature,
		location: target.artifactRef.startsWith("memory://")
			? target.artifactRef
			: relative(cwd, target.artifactRef) || target.artifactRef,
		async: target.async,
	}));
}

function table(rows: readonly DiscoveredRow[]): string {
	if (rows.length === 0) {
		return 'No trainables found. Mark one with the "use training" directive or the @trainable() decorator.';
	}
	const width = Math.max(...rows.map((row) => row.id.length));
	const lines = rows.map((row) => `${row.id.padEnd(width)}  ${row.location}\n${" ".repeat(width)}  ${row.signature}`);
	return [
		...lines,
		"",
		`${rows.length} trainable${rows.length === 1 ? "" : "s"}.`,
		"",
		"Bind evals with your own symbol key:",
		"  export const route: unique symbol = Symbol(\"route\");",
		`  // @trainable(route) on ${rows[0]?.id ?? "Class.method"}, then:`,
		"  await training.train(route, { /* ... */ });",
	].join("\n");
}

/** Reads the records a run wrote, if any. Absent artifacts are not an error:
 * "nothing captured yet" is the normal state before an app has served traffic. */
async function readRecords(outputDir: string): Promise<readonly TrainingRecord[]> {
	const path = `${outputDir}/records.json`;
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
		return Array.isArray(parsed) ? parsed as TrainingRecord[] : [];
	} catch {
		return [];
	}
}

function statusTable(targets: readonly TrainableTarget[], records: readonly TrainingRecord[]): string {
	const counts = new Map<string, { total: number; succeeded: number }>();
	for (const record of records) {
		const entry = counts.get(record.trainableId) ?? { total: 0, succeeded: 0 };
		entry.total += 1;
		if (record.succeeded) entry.succeeded += 1;
		counts.set(record.trainableId, entry);
	}
	if (targets.length === 0) return "No trainables found.";
	const width = Math.max(...targets.map((target) => target.id.length));
	return targets.map((target) => {
		const entry = counts.get(target.id) ?? { total: 0, succeeded: 0 };
		return `${target.id.padEnd(width)}  ${entry.succeeded} successful / ${entry.total} captured`;
	}).join("\n");
}

function sourceSettings(values: Record<string, unknown>): SourceSettings {
	const files = values["file"] as string[] | undefined;
	return {
		...(typeof values["cwd"] === "string" ? { cwd: values["cwd"] } : {}),
		...(typeof values["project"] === "string" ? { tsconfig: values["project"] } : {}),
		...(files && files.length > 0 ? { files } : {}),
	};
}

/** The CLI as a function, so it is testable without spawning a process. */
export async function run(argv: readonly string[]): Promise<CliResult> {
	let parsed: ReturnType<typeof parseArgs>;
	try {
		parsed = parseArgs({
			args: [...argv],
			allowPositionals: true,
			options: {
				cwd: { type: "string" },
				project: { type: "string" },
				file: { type: "string", multiple: true },
				"output-dir": { type: "string" },
				json: { type: "boolean" },
				help: { type: "boolean", short: "h" },
			},
		});
	} catch (error) {
		return { code: 2, stdout: "", stderr: `${(error as Error).message}\n\n${usage}` };
	}

	const command = parsed.positionals[0] ?? (parsed.values["help"] ? "help" : undefined);
	if (command === undefined || command === "help") {
		return { code: command === undefined ? 2 : 0, stdout: command === "help" ? usage : "", stderr: command === undefined ? usage : "" };
	}

	const settings = sourceSettings(parsed.values);
	const cwd = settings.cwd ?? process.cwd();

	try {
		if (command === "discover") {
			const rows = describeTrainables(discoverTrainables(settings), cwd);
			return { code: 0, stdout: `${parsed.values["json"] ? JSON.stringify(rows, null, 2) : table(rows)}\n`, stderr: "" };
		}
		if (command === "status") {
			const targets = discoverTrainables(settings);
			const records = await readRecords((parsed.values["output-dir"] as string | undefined) ?? ".agentv");
			if (parsed.values["json"]) {
				const rows = targets.map((target) => ({
					id: target.id,
					captured: records.filter((record) => record.trainableId === target.id).length,
					succeeded: records.filter((record) => record.trainableId === target.id && record.succeeded).length,
				}));
				return { code: 0, stdout: `${JSON.stringify(rows, null, 2)}\n`, stderr: "" };
			}
			return { code: 0, stdout: `${statusTable(targets, records)}\n`, stderr: "" };
		}
		return { code: 2, stdout: "", stderr: `unknown command: ${command}\n\n${usage}` };
	} catch (error) {
		// Library errors already say what to fix; anything else is a real crash.
		if (isTsAutocodeError(error)) return { code: 1, stdout: "", stderr: `${error.message}\n` };
		throw error;
	}
}

/** Exposed so `discover`'s suggested snippet stays true to the real API. */
export { defineTrainable };
