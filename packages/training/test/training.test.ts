import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import "./wiring.js";

import * as publicApi from "../src/index.js";
import {
	captureTrainable,
	configureTraining,
	defineTrainable,
	training as defaultTraining,
	type Activation,
	type ImplementationExecutor,
	type TrainingEngine,
} from "../src/index.js";

describe("trainable identity", () => {
	it("marks methods with only the directive and exposes no weaving API", () => {
		class Router {
			route(input: string): string {
				"use training";
				return input.toUpperCase();
			}
		}

		expect(new Router().route("billing")).toBe("BILLING");
		expect("useTraining" in publicApi).toBe(false);
		expect("createTraining" in publicApi).toBe(false);
		expect("default" in publicApi).toBe(false);
		// Weaving and decorators live with the instrumentation wiring, not here.
		expect("trainable" in publicApi).toBe(false);
		expect("instrumentTrainable" in publicApi).toBe(false);
		expect("wrapTrainable" in publicApi).toBe(false);
	});

	it("uses a durable id and stable symbol", () => {
		const first = defineTrainable("Router.route");
		const second = defineTrainable("Router.route");
		expect(first.symbol).toBe(second.symbol);
	});

	it("rejects string identities in training APIs", async () => {
		await expect(defaultTraining.records("Router.route" as never)).rejects.toThrow(
			"must be a symbol or TrainableToken",
		);
	});
});

describe("trainable method capture", () => {
	it("controls capture and tracing only through global settings", async () => {
		const startActiveSpan = vi.fn();
		const training = configureTraining({
			capture: { enabled: false },
			tracing: { enabled: false, tracer: { startActiveSpan } as never },
		});

		expect(captureTrainable("Router.route", "route", undefined, (input: string) => input, ["billing"])).toBe("billing");
		expect(startActiveSpan).not.toHaveBeenCalled();
		expect(await training.records(defineTrainable("Router.route"))).toEqual([]);
	});

	it("lets capture mappers redact values to undefined", async () => {
		const training = configureTraining({
			tracing: { enabled: false },
			capture: { mapInput: () => undefined, mapOutput: () => undefined },
		});
		const redacted = defineTrainable("Router.redacted");

		expect(captureTrainable(redacted.id, "route", undefined, (input: string) => input, ["secret-input"])).toBe("secret-input");
		const [record] = await training.records(redacted.symbol);
		expect(record?.succeeded).toBe(true);
		expect(JSON.stringify(record)).not.toContain("secret-input");
	});

	it("captures failed asynchronous calls without source metadata", async () => {
		const training = configureTraining({});
		const fail = async (): Promise<void> => {
			throw new Error("boom");
		};

		await expect(captureTrainable("Router.fail", "fail", undefined, fail, [])).rejects.toThrow("boom");
		const [record] = await training.records(defineTrainable("Router.fail"));
		expect(record?.succeeded).toBe(false);
		expect(record?.trace.errorCount).toBe(1);
	});
});

describe("training execution", () => {
	it("trains from successful live traces and activates the gated candidate", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ts-autocode-live-"));
		const artifact = join(directory, "normalize.ts");
		await writeFile(artifact, `export function liveNormalize(input: string): string {
  "use training";
  return input;
}\n`);
		const optimize = vi.fn<TrainingEngine["optimize"]>(async (request) => {
			expect(request.records).toHaveLength(2);
			expect(request.evaluations).toHaveLength(2);
			return { implementation: "return input.toUpperCase();" };
		});
		const training = configureTraining({
			engine: { id: "live-test", optimize },
			executor: functionExecutor,
			source: { files: [artifact] },
			tracing: { enabled: false },
		});
		const normalize = (input: string) =>
			captureTrainable("liveNormalize", "normalize", undefined, (value: string) => value.toUpperCase(), [input]);
		normalize("alpha");
		normalize("beta");

		const run = await training.train({
			trainable: defineTrainable("liveNormalize").symbol,
			objective: "Preserve behavior observed in live traces",
			minTraces: 2,
			evaluation: { workers: 2, outputDir: join(directory, "agentv") },
		});
		expect(run.outcome).toBe("ready");
		expect(run.baseline.run.summary.passed).toBe(2);
		expect(run.final.verification.run.summary.passed).toBe(2);

		const activation = await run.activate();
		expect(await readFile(artifact, "utf8")).toContain("return input.toUpperCase();");
		expect(await readFile(artifact, "utf8")).toContain('"use training"');

		// Rollback restores the pre-activation source exactly.
		await activation.rollback();
		expect(await readFile(artifact, "utf8")).not.toContain("return input.toUpperCase();");
	});

	it("evolves automatically from runtime traffic when evolution is enabled", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ts-autocode-auto-"));
		const artifact = join(directory, "auto.ts");
		await writeFile(artifact, `export function autoNormalize(input: string): string {
  "use training";
  return input;
}\n`);
		let resolveEvolved!: (activation: Activation) => void;
		const evolved = new Promise<Activation>((resolve) => { resolveEvolved = resolve; });
		const errors: unknown[] = [];
		configureTraining({
			engine: { id: "auto-test", optimize: async () => ({ implementation: "return input.toUpperCase();" }) },
			executor: functionExecutor,
			source: { files: [artifact] },
			tracing: { enabled: false },
			onError: (error) => errors.push(error),
			evolution: {
				enabled: true,
				minTraces: 2,
				evaluation: { outputDir: join(directory, "agentv") },
				onEvolved: (activation) => resolveEvolved(activation),
			},
		});
		const normalize = (input: string) =>
			captureTrainable("autoNormalize", "normalize", undefined, (value: string) => value.toUpperCase(), [input]);
		normalize("alpha");
		normalize("beta");

		const activation = await evolved;
		expect(errors).toEqual([]);
		expect(activation.run.outcome).toBe("ready");
		expect(await readFile(artifact, "utf8")).toContain("return input.toUpperCase();");
		expect(await readFile(artifact, "utf8")).toContain('"use training"');
	});

	it("treats engine validation as source conformance at the promotion gate", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ts-autocode-conformance-"));
		const artifact = join(directory, "echo.ts");
		await writeFile(artifact, `export function echo(input: string): string {
  "use training";
  return input;
}\n`);
		const training = configureTraining({
			engine: { id: "conformance-test", optimize: async () => ({ implementation: "return input.toUpperCase();" }) },
			executor: functionExecutor,
			source: { files: [artifact] },
			tracing: { enabled: false },
		});

		const run = await training.train({
			trainable: defineTrainable("echo").symbol,
			objective: "Uppercase the input",
			evaluation: {
				tests: [{ id: "upper", input: "abc", assert: [{ type: "equals", value: "ABC" }] }],
				task: (input) => input,
				outputDir: join(directory, "agentv"),
			},
		});

		expect(run.outcome).toBe("ready");
		expect(run.final.decision.failures).toEqual([]);
	});

	it("routes eval artifacts through the configured output directory", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ts-autocode-output-"));
		const artifact = join(directory, "echo.ts");
		await writeFile(artifact, `export function echoOut(input: string): string {
  "use training";
  return input;
}\n`);
		const training = configureTraining({
			engine: { id: "output-test", optimize: async () => ({ implementation: "return input.toUpperCase();" }) },
			executor: functionExecutor,
			source: { files: [artifact] },
			tracing: { enabled: false },
			outputDir: join(directory, "runs"),
		});

		const run = await training.train({
			trainable: defineTrainable("echoOut").symbol,
			objective: "Uppercase the input",
			evaluation: {
				tests: [{ id: "upper", input: "abc", assert: [{ type: "equals", value: "ABC" }] }],
				task: (input) => input.toUpperCase(),
			},
		});

		expect(run.outcome).toBe("ready");
		await expect(stat(join(directory, "runs"))).resolves.toBeTruthy();
	});

	it("requires enough successful runtime traces before training from captured traffic", async () => {
		const training = configureTraining({ tracing: { enabled: false } });
		const live = defineTrainable("Router.live");
		captureTrainable(live.id, "route", undefined, (input: string) => input, ["one"]);

		await expect(training.train({
			trainable: live.symbol,
			objective: "Improve routing",
			minTraces: 2,
		})).rejects.toThrow("requires 2 distinct successful runtime traces; found 1");
	});
});

const functionExecutor: ImplementationExecutor = async (target, implementation, args) =>
	new Function(...target.parameters.map((parameter) => parameter.name), implementation)(...args);
