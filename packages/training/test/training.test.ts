import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import "./wiring.js";

import * as publicApi from "../src/index.js";
import {
	createTrainingRuntime,
	captureTrainable,
	configureTraining,
	defineTrainable,
	MemoryTrainingStore,
	training as defaultTraining,
	type Activation,
	type ImplementationExecutor,
	type PromotionApplier,
	type TrainingEngine,
	type TrainingStore,
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
		// No wrapper a consumer must call to mark a trainable: the directive is
		// the marker. `createTrainingRuntime` is a runtime factory, not one of
		// these, and is deliberately named apart from them.
		expect("useTraining" in publicApi).toBe(false);
		expect("createTraining" in publicApi).toBe(false);
		expect("markTrainable" in publicApi).toBe(false);
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

describe("training resilience policies", () => {
	it("retries store appends under a store policy without surfacing an error", async () => {
		const inner = new MemoryTrainingStore();
		let failures = 1;
		const store: TrainingStore = {
			append: async (record) => {
				if (failures > 0) {
					failures -= 1;
					throw new Error("flaky store");
				}
				await inner.append(record);
			},
			list: (trainableId) => inner.list(trainableId),
		};
		const onError = vi.fn();
		const training = configureTraining({
			store,
			onError,
			tracing: { enabled: false },
			resilience: { store: { retry: { attempts: 2, delayMs: 1, jitter: false } } },
		});

		captureTrainable("Router.storeRetry", "route", undefined, (input: string) => input, ["billing"]);
		await training.flush();

		expect(onError).not.toHaveBeenCalled();
		expect(await training.records(defineTrainable("Router.storeRetry"))).toHaveLength(1);
	});

	it("routes store failures to onError when no store policy is configured", async () => {
		const failure = new Error("store down");
		const onError = vi.fn();
		const training = configureTraining({
			store: { append: async () => { throw failure; }, list: async () => [] },
			onError,
			tracing: { enabled: false },
		});

		captureTrainable("Router.storeDown", "route", undefined, (input: string) => input, ["billing"]);
		await training.flush();

		expect(onError).toHaveBeenCalledWith(failure, "store");
	});

	it("retries engine proposals under a propose policy", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ts-autocode-propose-retry-"));
		const artifact = join(directory, "echo.ts");
		await writeFile(artifact, `export function echoRetry(input: string): string {
  "use training";
  return input;
}\n`);
		let failures = 1;
		const optimize = vi.fn<TrainingEngine["optimize"]>(async () => {
			if (failures > 0) {
				failures -= 1;
				throw new Error("rate limited");
			}
			return { implementation: "return input.toUpperCase();" };
		});
		const training = configureTraining({
			engine: { id: "propose-retry-test", optimize },
			executor: functionExecutor,
			source: { files: [artifact] },
			tracing: { enabled: false },
			resilience: { propose: { retry: { attempts: 2, delayMs: 1, jitter: false } } },
		});

		const run = await training.train({
			trainable: defineTrainable("echoRetry").symbol,
			objective: "Uppercase the input",
			evaluation: {
				tests: [{ id: "upper", input: "abc", assert: [{ type: "equals", value: "ABC" }] }],
				task: (input) => input.toUpperCase(),
				outputDir: join(directory, "agentv"),
			},
		});

		expect(run.outcome).toBe("ready");
		expect(optimize).toHaveBeenCalledTimes(2);
	});
});

const functionExecutor: ImplementationExecutor = async (target, implementation, args) =>
	new Function(...target.parameters.map((parameter) => parameter.name), implementation)(...args);

describe("capture on an isolated runtime", () => {
	// `captureTrainable` routes to the process-wide runtime, so a runtime built
	// with `createTrainingRuntime` could train and evaluate but never capture --
	// half a runtime, and exactly the case isolation exists for. Found while
	// writing fault-injection tests against an isolated runtime.
	it("records through the runtime it was called on, not the global one", async () => {
		const isolated = createTrainingRuntime({ tracing: { enabled: false } });
		const other = createTrainingRuntime({ tracing: { enabled: false } });
		const token = defineTrainable("Isolated.route");

		expect(isolated.capture(token, "route", undefined, (input: string) => input.toUpperCase(), ["abc"]))
			.toBe("ABC");
		await isolated.flush();
		await other.flush();

		expect((await isolated.records(token)).length).toBe(1);
		expect((await other.records(token)).length).toBe(0);
	});

	it("accepts a symbol identity as well as a token", async () => {
		const isolated = createTrainingRuntime({ tracing: { enabled: false } });
		const token = defineTrainable("Isolated.symbol");
		isolated.capture(token.symbol, "route", undefined, (input: string) => input, ["x"]);
		await isolated.flush();
		expect((await isolated.records(token)).length).toBe(1);
	});

	it("preserves this, arguments, return values and thrown errors", async () => {
		const isolated = createTrainingRuntime({ tracing: { enabled: false } });
		const token = defineTrainable("Isolated.receiver");
		const receiver = { suffix: "!" };
		function method(this: typeof receiver, input: string): string {
			return `${input}${this.suffix}`;
		}
		expect(isolated.capture(token, "method", receiver, method, ["hi"])).toBe("hi!");

		const boom = () => { throw new Error("thrown"); };
		expect(() => isolated.capture(token, "boom", undefined, boom, [])).toThrow("thrown");
		await isolated.flush();
		const records = await isolated.records(token);
		expect(records.map((record) => record.succeeded)).toEqual([true, false]);
	});

	it("awaits an async method and records its settled outcome", async () => {
		const isolated = createTrainingRuntime({ tracing: { enabled: false } });
		const token = defineTrainable("Isolated.async");
		await expect(isolated.capture(token, "slow", undefined, async (input: string) => input, ["x"]))
			.resolves.toBe("x");
		await isolated.flush();
		expect((await isolated.records(token))[0]?.succeeded).toBe(true);
	});
});

describe("promotion applier on an isolated runtime", () => {
	// Every other seam resolved `settings.X ?? defaultProviders.X`; `promote`
	// alone read the process-wide provider, so an applier could not be injected
	// per runtime. `createTrainingRuntime` therefore left one seam global -- the
	// one that writes generated code into a source file. Found while writing the
	// provider authoring guide: the wiring example would not compile.
	async function trained(promote: PromotionApplier, name: string) {
		const directory = await mkdtemp(join(tmpdir(), `ts-autocode-${name}-`));
		const artifact = join(directory, "echo.ts");
		await writeFile(artifact, `export function ${name}(input: string): string {
  "use training";
  return input;
}\n`);
		const runtime = createTrainingRuntime({
			engine: { id: "applier-test", optimize: async () => ({ implementation: "return input.toUpperCase();" }) },
			executor: functionExecutor,
			promote,
			source: { files: [artifact] },
			tracing: { enabled: false },
		});
		const run = await runtime.train({
			trainable: defineTrainable(name).symbol,
			evaluation: {
				tests: [{ id: "upper", input: "abc", assert: [{ type: "equals", value: "ABC" }] }],
				task: (input) => input.toUpperCase(),
				outputDir: join(directory, "agentv"),
			},
			rounds: { max: 1 },
		});
		expect(run.outcome).toBe("ready");
		return run;
	}

	it("prefers the runtime's applier over the process-wide one", async () => {
		const applied: string[] = [];
		const run = await trained(async (candidate) => {
			applied.push(candidate.id);
			return { rollback: async () => { applied.push("rolled-back"); } };
		}, "applierPreferred");

		const activation = await run.activate();
		expect(applied).toHaveLength(1);
		await activation.rollback();
		expect(applied.at(-1)).toBe("rolled-back");
	});

	it("keeps two runtimes' appliers apart", async () => {
		const first: string[] = [];
		const second: string[] = [];
		const runs = await Promise.all([
			trained(async () => { first.push("applied"); return { rollback: async () => {} }; }, "applierFirst"),
			trained(async () => { second.push("applied"); return { rollback: async () => {} }; }, "applierSecond"),
		]);

		await runs[0]?.activate();

		expect(first).toEqual(["applied"]);
		expect(second).toEqual([]);
	});

});
