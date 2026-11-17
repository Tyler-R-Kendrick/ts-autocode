import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
	defineTrainable,
	discoverTrainables,
	isTsAutocodeError,
	type SourceSettings,
	type TrainInput,
	type TrainableIdentity,
	type TrainableTarget,
	type Training,
	type TrainingRecord,
} from "ts-autocode-training";

import { training } from "./index.js";

export const usage = `ts-autocode <command> [options]

Commands:
  discover            List every trainable the TypeScript project marks.
  status              Show captured traces per trainable, read from the
                      records artifact at <output-dir>/records.json. A store
                      must persist that artifact; the default in-memory store
                      does not, so a fresh project reports zero captures.
  train               Train the identity exported by a local configuration module.
  help                Show this message.

Options:
  --cwd <dir>         Project root (default: the working directory).
  --project <file>    tsconfig to read (default: tsconfig.json).
  --file <path>       Scan only these files; repeatable.
  --output-dir <dir>  Where run artifacts live (default: .agentv).
  --json              Emit JSON instead of a table.
  --module <file>     JavaScript configuration module for train.
  --export <name>     Configuration export for train (default: default).
  --activate          Apply an accepted candidate after training.
`;

export interface CliResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface CliTrainingRequest {
	readonly trainable: TrainableIdentity;
	readonly input?: Omit<TrainInput, "trainable">;
	readonly runtime?: Training;
}

class CliUsageError extends Error {}

interface DiscoveredRow {
	readonly id: string;
	readonly signature: string;
	readonly location: string;
	readonly async: boolean;
}

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
		`  Mark ${rows[0]?.id ?? "Class.method"} with @trainable(route), then pass route to training.train.`,
	].join("\n");
}

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

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadTrainingRequest(modulePath: string, exportName: string, cwd: string): Promise<CliTrainingRequest> {
	let namespace: Record<string, unknown>;
	try {
		namespace = await import(pathToFileURL(resolve(cwd, modulePath)).href) as Record<string, unknown>;
	} catch (error) {
		throw new CliUsageError(`cannot load training module ${modulePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const request = namespace[exportName];
	if (!record(request) || !("trainable" in request)) {
		throw new CliUsageError(`training export ${exportName} must be an object with a trainable identity`);
	}
	const identity = request.trainable;
	if (typeof identity !== "symbol" && typeof identity !== "function" && !(record(identity) && typeof identity.id === "string" && typeof identity.symbol === "symbol")) {
		throw new CliUsageError("trainable must be a symbol, marked function, or trainable token");
	}
	if (request.input !== undefined && (!record(request.input) || "trainable" in request.input)) {
		throw new CliUsageError("training input must be an object without a trainable field");
	}
	if (request.runtime !== undefined && (!record(request.runtime) || typeof request.runtime.train !== "function")) {
		throw new CliUsageError("training runtime must provide train()");
	}
	return request as unknown as CliTrainingRequest;
}

async function trainFromModule(values: Record<string, unknown>, cwd: string): Promise<CliResult> {
	if (typeof values.module !== "string" || !values.module.trim()) throw new CliUsageError("train requires --module <file>");
	if (values.project !== undefined || values.file !== undefined) throw new CliUsageError("--project and --file apply to discovery, not train");
	const exportName = typeof values.export === "string" ? values.export : "default";
	if (!exportName) throw new CliUsageError("--export must name a module export");
	const request = await loadTrainingRequest(values.module, exportName, cwd);
	const input = typeof values["output-dir"] === "string"
		? { ...request.input, evaluation: { ...request.input?.evaluation, outputDir: resolve(cwd, values["output-dir"]) } }
		: request.input;
	const run = await (request.runtime ?? training).train(request.trainable, input);
	const readiness = run.canActivate();
	const activated = values.activate === true && readiness.ready;
	if (activated) await run.activate();
	const summary = { outcome: run.outcome, rounds: run.rounds.length, candidate: run.final.candidate.id, readiness, activated };
	const stdout = values.json === true
		? `${JSON.stringify(summary, null, 2)}\n`
		: `Outcome: ${summary.outcome}\nCandidate: ${summary.candidate}\nReady to activate: ${readiness.ready ? "yes" : "no"}\nActivated: ${activated ? "yes" : "no"}\n${readiness.ready ? "" : `${readiness.failures.join("\n")}\n`}`;
	return { code: readiness.ready ? 0 : 1, stdout, stderr: "" };
}

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
				module: { type: "string" },
				export: { type: "string" },
				activate: { type: "boolean" },
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
		if (command === "train") return await trainFromModule(parsed.values, cwd);
		if (parsed.values.module !== undefined || parsed.values.export !== undefined || parsed.values.activate === true) {
			throw new CliUsageError("--module, --export, and --activate apply only to train");
		}
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
		if (error instanceof CliUsageError) return { code: 2, stdout: "", stderr: `${error.message}\n` };
		if (isTsAutocodeError(error)) return { code: 1, stdout: "", stderr: `${error.message}\n` };
		throw error;
	}
}

export { defineTrainable };
