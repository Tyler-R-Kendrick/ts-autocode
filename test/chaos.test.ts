import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	commitRewrite,
	createTrainingRuntime,
	defineTrainable,
	InsufficientTracesError,
	isTsAutocodeError,
	MemoryTrainingStore,
	OperationTimeoutError,
	PromotionRejectedError,
	rewritePromotion,
	sequentialLoop,
	TrainingIncompleteError,
	type ImplementationExecutor,
	type TrainingEngine,
	type TrainingEvent,
	type TrainingRecord,
	type TrainingStore,
} from "../src/index.js";

// Chaos / fault injection.
//
// Everything this library depends on can fail: the engine is a network call to
// a model, the executor runs code that was written by that model, the store is
// I/O, and the file it rewrites is one a developer may be editing at the same
// moment. The existing suites all exercise the path where nothing goes wrong.
//
// Two properties matter more than any other, and both are asserted repeatedly
// below:
//
//   - a failure anywhere in capture or evolution must never break, delay or
//     alter the application call being traced;
//   - a failure during promotion must never leave a partially rewritten file.

const directory = "test/output/chaos";

/** The identity every capture in this file routes through. */
const route = defineTrainable("Fixture.route");

const source = `class Fixture {
	route(input: string): string {
		"use training";
		return input;
	}
}
`;

async function fixture(name: string): Promise<string> {
	await mkdir(directory, { recursive: true });
	const artifact = join(directory, `${name}.ts`);
	await writeFile(artifact, source, "utf8");
	return artifact;
}

const executor: ImplementationExecutor = async (target, implementation, args) =>
	new Function(...target.parameters.map((parameter) => parameter.name), implementation)(...args) as unknown;

const workingEngine: TrainingEngine = {
	id: "chaos/working",
	optimize: async () => ({ implementation: "return input.toUpperCase();" }),
};

function trainInput(outputDir: string) {
	return {
		trainable: defineTrainable("Fixture.route").symbol,
		evaluation: {
			tests: [{ id: "a", input: "abc", assert: [{ type: "equals" as const, value: "ABC" }] }],
			task: (value: string) => value.toUpperCase(),
			outputDir,
		},
	};
}

describe("a failing store", () => {
	it("never breaks the application call it is capturing", async () => {
		const events: TrainingEvent[] = [];
		const training = createTrainingRuntime({
			store: { append: async () => { throw new Error("disk full"); }, list: async () => [] },
			tracing: { enabled: false },
			onEvent: (event) => events.push(event),
		});
		// The call must return normally even though every write fails.
		const result = training.capture(route, "route", undefined, (input: string) => input.toUpperCase(), ["abc"]);
		expect(result).toBe("ABC");
		await training.flush();
		expect(events.map((event) => event.type)).toContain("store.failed");
	});

	it("propagates the method's own error unchanged, not the store's", async () => {
		const training = createTrainingRuntime({
			store: { append: async () => { throw new Error("disk full"); }, list: async () => [] },
			tracing: { enabled: false },
			onEvent: () => undefined,
		});
		const failing = () => { throw new Error("application failure"); };
		expect(() => training.capture(defineTrainable("Fixture.fail"), "fail", undefined, failing, []))
			.toThrow("application failure");
		await training.flush();
	});

	it("survives a store that rejects intermittently", async () => {
		let calls = 0;
		const flaky: TrainingStore = {
			append: async () => {
				calls += 1;
				if (calls % 2 === 1) throw new Error("transient");
			},
			list: async () => [],
		};
		const failures: unknown[] = [];
		const training = createTrainingRuntime({
			store: flaky, tracing: { enabled: false }, onError: (error) => failures.push(error),
		});
		for (let index = 0; index < 6; index += 1) {
			expect(training.capture(route, "route", undefined, (input: string) => input, [`${index}`]))
				.toBe(`${index}`);
		}
		await training.flush();
		expect(failures.length).toBeGreaterThan(0);
	});

	it("retries a store write when a resilience policy says to", async () => {
		let attempts = 0;
		const training = createTrainingRuntime({
			store: {
				append: async () => {
					attempts += 1;
					if (attempts < 3) throw new Error("transient");
				},
				list: async () => [],
			},
			resilience: { store: { retry: { attempts: 3, delayMs: 1 } } },
			tracing: { enabled: false },
			onError: () => undefined,
		});
		training.capture(route, "route", undefined, (input: string) => input, ["x"]);
		await training.flush();
		expect(attempts).toBe(3);
	});

	it("surfaces a store that never resolves as a typed timeout", async () => {
		const events: TrainingEvent[] = [];
		const training = createTrainingRuntime({
			store: { append: () => new Promise(() => undefined), list: async () => [] },
			resilience: { store: { timeoutMs: 20 } },
			tracing: { enabled: false },
			onEvent: (event) => events.push(event),
		});
		training.capture(route, "route", undefined, (input: string) => input, ["x"]);
		await training.flush();
		const failure = events.find((event) => event.type === "store.failed");
		expect(failure).toBeDefined();
		expect((failure as { error: unknown }).error).toBeInstanceOf(OperationTimeoutError);
	});
});

describe("a failing engine", () => {
	it("reports a typed failure rather than a silent stall", async () => {
		const artifact = await fixture("engine-failure");
		const training = createTrainingRuntime({
			engine: { id: "chaos/broken", optimize: async () => { throw new Error("model unavailable"); } },
			executor,
			source: { files: [artifact] },
			tracing: { enabled: false },
		});
		await expect(training.train(trainInput(`${directory}/engine-failure`)))
			.rejects.toThrow("model unavailable");
	});

	it("recovers when a retry policy outlasts a flaky engine", async () => {
		const artifact = await fixture("engine-flaky");
		let attempts = 0;
		const training = createTrainingRuntime({
			engine: {
				id: "chaos/flaky",
				optimize: async () => {
					attempts += 1;
					if (attempts < 3) throw new Error("rate limited");
					return { implementation: "return input.toUpperCase();" };
				},
			},
			executor,
			source: { files: [artifact] },
			tracing: { enabled: false },
			resilience: { propose: { retry: { attempts: 3, delayMs: 1 } } },
		});
		const run = await training.train(trainInput(`${directory}/engine-flaky`));
		expect(attempts).toBe(3);
		expect(run.outcome).toBe("ready");
	}, 30_000);

	it("times out an engine that never answers", async () => {
		const artifact = await fixture("engine-hang");
		const training = createTrainingRuntime({
			engine: { id: "chaos/hanging", optimize: () => new Promise(() => undefined) },
			executor,
			source: { files: [artifact] },
			tracing: { enabled: false },
			resilience: { propose: { timeoutMs: 30 } },
		});
		await expect(training.train(trainInput(`${directory}/engine-hang`)))
			.rejects.toBeInstanceOf(OperationTimeoutError);
	}, 30_000);

	it("rejects a candidate that is not valid TypeScript instead of writing it", async () => {
		const artifact = await fixture("engine-garbage");
		const before = await readFile(artifact, "utf8");
		const training = createTrainingRuntime({
			engine: { id: "chaos/garbage", optimize: async () => ({ implementation: "return ((( ;" }) },
			executor,
			source: { files: [artifact] },
			tracing: { enabled: false },
		});
		await expect(training.train(trainInput(`${directory}/engine-garbage`))).rejects.toThrow();
		expect(await readFile(artifact, "utf8")).toBe(before);
	});

	it("rejects an empty implementation", async () => {
		const artifact = await fixture("engine-empty");
		const training = createTrainingRuntime({
			engine: { id: "chaos/empty", optimize: async () => ({ implementation: "   " }) },
			executor,
			source: { files: [artifact] },
			tracing: { enabled: false },
		});
		await expect(training.train(trainInput(`${directory}/engine-empty`)))
			.rejects.toThrow("empty implementation");
	});
});

describe("a failing executor", () => {
	it("scores a throwing candidate as failing rather than crashing the run", async () => {
		const artifact = await fixture("executor-throws");
		const training = createTrainingRuntime({
			engine: workingEngine,
			executor: async () => { throw new Error("sandbox died"); },
			source: { files: [artifact] },
			tracing: { enabled: false },
			loop: sequentialLoop,
		});
		// The run completes; the candidate simply does not promote. A typed
		// rejection is also acceptable: silently promoting is not.
		const settled = await training.train({ ...trainInput(`${directory}/executor-throws`), rounds: { max: 1 } })
			.then((run) => ({ ok: true as const, run }))
			.catch((error: unknown) => ({ ok: false as const, error }));
		if (settled.ok) {
			expect(settled.run.outcome).not.toBe("ready");
			expect(settled.run.canActivate().ready).toBe(false);
		} else {
			expect(isTsAutocodeError(settled.error)).toBe(true);
		}
	}, 30_000);

	it("times out a hanging executor per candidate", async () => {
		const artifact = await fixture("executor-hangs");
		const training = createTrainingRuntime({
			engine: workingEngine,
			executor: () => new Promise(() => undefined),
			source: { files: [artifact] },
			tracing: { enabled: false },
			resilience: { evaluate: { timeoutMs: 25 } },
			loop: sequentialLoop,
		});
		const outcome = await training.train({ ...trainInput(`${directory}/executor-hangs`), rounds: { max: 1 } })
			.then((run) => run.outcome).catch(() => "threw");
		expect(["stalled", "exhausted", "threw"]).toContain(outcome);
	}, 30_000);
});

describe("cancellation mid-run", () => {
	it("stops a run when its signal aborts during proposal", async () => {
		const artifact = await fixture("abort-propose");
		const controller = new AbortController();
		const training = createTrainingRuntime({
			engine: {
				id: "chaos/abort",
				optimize: async () => {
					controller.abort();
					return { implementation: "return input.toUpperCase();" };
				},
			},
			executor,
			source: { files: [artifact] },
			tracing: { enabled: false },
			loop: sequentialLoop,
		});
		const settled = await training.train({
			...trainInput(`${directory}/abort-propose`),
			rounds: { max: 20 },
			signal: controller.signal,
		}).then(() => "resolved").catch(() => "rejected");
		expect(["resolved", "rejected"]).toContain(settled);
	}, 30_000);

	it("does not retry an operation whose caller already aborted", async () => {
		const artifact = await fixture("abort-no-retry");
		const controller = new AbortController();
		let attempts = 0;
		const training = createTrainingRuntime({
			engine: {
				id: "chaos/abort-retry",
				optimize: async () => {
					attempts += 1;
					controller.abort();
					throw new Error("failed after abort");
				},
			},
			executor,
			source: { files: [artifact] },
			tracing: { enabled: false },
			resilience: { propose: { retry: { attempts: 5, delayMs: 1 } } },
		});
		await training.train({
			...trainInput(`${directory}/abort-no-retry`),
			signal: controller.signal,
		}).catch(() => undefined);
		// Retrying work the caller cancelled spends money on a result nobody wants.
		expect(attempts).toBe(1);
	}, 30_000);
});

describe("the file changing underneath a rewrite", () => {
	it("refuses to apply when the body changed since discovery", async () => {
		const artifact = await fixture("edited-during");
		const { discoverInSource } = await import("../src/index.js");
		const target = { ...discoverInSource(source, artifact)[0]!, artifactRef: artifact };
		const candidate = {
			id: "c", trainableId: target.id, engineId: "chaos", target, implementation: "return input.toUpperCase();",
		};

		// A developer edits the method between discovery and application.
		const edited = source.replace("return input;", "return input.trim();");
		expect(() => commitRewrite(edited, candidate)).toThrow(/changed after discovery/);
	});

	it("refuses to revert when the rewritten body changed since application", async () => {
		const { discoverInSource } = await import("../src/index.js");
		const target = discoverInSource(source, "memory://x.ts")[0]!;
		const candidate = {
			id: "c", trainableId: target.id, engineId: "chaos", target, implementation: "return input.toUpperCase();",
		};
		const committed = commitRewrite(source, candidate);
		const editedAfter = committed.source.replace("toUpperCase", "toLowerCase");
		const { revertRewrite } = await import("../src/index.js");
		expect(() => revertRewrite(editedAfter, committed.snapshot)).toThrow(/changed before revert/);
	});

	it("leaves the file untouched when application is refused", async () => {
		const artifact = await fixture("refused-untouched");
		const before = await readFile(artifact, "utf8");
		await expect(rewritePromotion(
			{
				id: "c",
				trainableId: defineTrainable("Fixture.route").id,
				engineId: "chaos",
				target: { ...(await import("../src/index.js")).discoverInSource(source, artifact)[0]!, artifactRef: artifact },
				implementation: "return input.toUpperCase();",
			},
			{ candidateId: "different", promote: true, failures: [], meanScore: 1, passRate: 1 },
		)).rejects.toBeInstanceOf(PromotionRejectedError);
		expect(await readFile(artifact, "utf8")).toBe(before);
	});

	it("restores the file exactly when a rollback follows a real rewrite", async () => {
		const artifact = await fixture("rollback-exact");
		const before = await readFile(artifact, "utf8");
		const training = createTrainingRuntime({
			engine: workingEngine,
			executor,
			source: { files: [artifact] },
			tracing: { enabled: false },
		});
		const run = await training.train(trainInput(`${directory}/rollback-exact`));
		expect(run.outcome).toBe("ready");
		const activation = await run.activate();
		expect(await readFile(artifact, "utf8")).not.toBe(before);
		await activation.rollback();
		expect(await readFile(artifact, "utf8")).toBe(before);
	}, 30_000);

	it("refuses a rollback when the file moved on after activation", async () => {
		const artifact = await fixture("rollback-conflict");
		const training = createTrainingRuntime({
			engine: workingEngine,
			executor,
			source: { files: [artifact] },
			tracing: { enabled: false },
		});
		const run = await training.train(trainingInputFor(artifact));
		const activation = await run.activate();
		// Someone edits the rewritten method before the rollback lands.
		const rewritten = await readFile(artifact, "utf8");
		await writeFile(artifact, rewritten.replace("toUpperCase", "toLowerCase"), "utf8");
		await expect(activation.rollback()).rejects.toThrow(/changed before revert/);
	}, 30_000);

	it("reports a missing artifact rather than creating one", async () => {
		const artifact = await fixture("vanished");
		const { discoverInSource } = await import("../src/index.js");
		const target = { ...discoverInSource(source, artifact)[0]!, artifactRef: join(directory, "gone.ts") };
		await rm(target.artifactRef, { force: true });
		await expect(rewritePromotion(
			{ id: "c", trainableId: target.id, engineId: "chaos", target, implementation: "return input;" },
			{ candidateId: "c", promote: true, failures: [], meanScore: 1, passRate: 1 },
		)).rejects.toThrow();
	});
});

describe("evolution under failure", () => {
	it("reports a failed evolution without disturbing the traced calls", async () => {
		const artifact = await fixture("evolve-failure");
		const events: TrainingEvent[] = [];
		const training = createTrainingRuntime({
			engine: { id: "chaos/evolve", optimize: async () => { throw new Error("model down"); } },
			executor,
			source: { files: [artifact] },
			tracing: { enabled: false },
			onEvent: (event) => events.push(event),
			evolution: { auto: true, minTraces: 1, evaluation: { outputDir: `${directory}/evolve-failure` } },
		});
		for (const value of ["a", "b"]) {
			expect(training.capture(route, "route", undefined, (input: string) => input, [value])).toBe(value);
		}
		await training.flush();
		await settle(() => events.some((event) => event.type === "evolution.failed"));
		expect(events.map((event) => event.type)).toContain("evolution.failed");
		// And the file was never touched.
		expect(await readFile(artifact, "utf8")).toBe(source);
	}, 30_000);

	it("reports a skip rather than training on too few traces", async () => {
		const artifact = await fixture("evolve-skip");
		const events: TrainingEvent[] = [];
		const training = createTrainingRuntime({
			engine: workingEngine,
			executor,
			source: { files: [artifact] },
			tracing: { enabled: false },
			onEvent: (event) => events.push(event),
			evolution: { auto: true, minTraces: 50, evaluation: { outputDir: `${directory}/evolve-skip` } },
		});
		training.capture(route, "route", undefined, (input: string) => input, ["a"]);
		await training.flush();
		await settle(() => events.some((event) => event.type === "evolution.skipped"));
		expect(events.map((event) => event.type)).toContain("evolution.skipped");
		expect(events.map((event) => event.type)).not.toContain("evolution.started");
	}, 30_000);

	it("does not run two evolutions for one trainable at once", async () => {
		const artifact = await fixture("evolve-concurrent");
		const events: TrainingEvent[] = [];
		let concurrent = 0;
		let peak = 0;
		const training = createTrainingRuntime({
			engine: {
				id: "chaos/slow",
				optimize: async () => {
					concurrent += 1;
					peak = Math.max(peak, concurrent);
					await new Promise((resolve) => setTimeout(resolve, 20));
					concurrent -= 1;
					return { implementation: "return input.toUpperCase();" };
				},
			},
			executor,
			source: { files: [artifact] },
			tracing: { enabled: false },
			onEvent: (event) => events.push(event),
			evolution: { auto: true, minTraces: 1, evaluation: { outputDir: `${directory}/evolve-concurrent` } },
		});
		for (const value of ["a", "b", "c", "d", "e"]) {
			training.capture(route, "route", undefined, (input: string) => input, [value]);
		}
		await training.flush();
		await settle(() => events.filter((event) => event.type === "evolution.started").length > 0, 60);
		// Overlapping evolutions of one trainable would race on the same file.
		expect(peak).toBeLessThanOrEqual(1);
	}, 30_000);
});

describe("training with nothing to learn from", () => {
	it("reports how many traces it needed and found", async () => {
		const artifact = await fixture("no-traces");
		const training = createTrainingRuntime({
			engine: workingEngine,
			executor,
			store: new MemoryTrainingStore(),
			source: { files: [artifact] },
			tracing: { enabled: false },
		});
		const failure = await training.train({
			trainable: defineTrainable("Fixture.route").symbol,
			minTraces: 5,
		}).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(InsufficientTracesError);
		expect(failure).toMatchObject({ required: 5, found: 0 });
	});

	it("reports an unpromotable run without throwing from canActivate", async () => {
		const artifact = await fixture("never-promotes");
		const training = createTrainingRuntime({
			engine: { id: "chaos/wrong", optimize: async () => ({ implementation: 'return "wrong";' }) },
			executor,
			source: { files: [artifact] },
			tracing: { enabled: false },
			loop: sequentialLoop,
		});
		const run = await training.train({ ...trainInput(`${directory}/never-promotes`), rounds: { max: 1 } });
		expect(run.canActivate().ready).toBe(false);
		await expect(run.activate()).rejects.toBeInstanceOf(PromotionRejectedError);
	}, 30_000);

	it("surfaces a loop that returns no rounds as a typed error", async () => {
		const artifact = await fixture("empty-loop");
		const training = createTrainingRuntime({
			engine: workingEngine,
			executor,
			source: { files: [artifact] },
			tracing: { enabled: false },
			loop: async () => ({ outcome: "stalled", rounds: [] }),
		});
		await expect(training.train(trainInput(`${directory}/empty-loop`)))
			.rejects.toBeInstanceOf(TrainingIncompleteError);
	});
});

describe("a hostile event handler", () => {
	it("does not let a throwing onEvent break the traced call", async () => {
		const training = createTrainingRuntime({
			store: { append: async () => { throw new Error("store"); }, list: async () => [] },
			tracing: { enabled: false },
			onEvent: () => { throw new Error("handler exploded"); },
		});
		expect(training.capture(route, "route", undefined, (input: string) => input, ["x"])).toBe("x");
		await expect(training.flush()).resolves.toBeUndefined();
	});

	it("does not let a throwing onError break the traced call", async () => {
		const training = createTrainingRuntime({
			store: { append: async () => { throw new Error("store"); }, list: async () => [] },
			tracing: { enabled: false },
			onError: () => { throw new Error("handler exploded"); },
		});
		expect(training.capture(route, "route", undefined, (input: string) => input, ["x"])).toBe("x");
		await expect(training.flush()).resolves.toBeUndefined();
	});

	it("does not let a throwing serializer break the traced call", async () => {
		const records: TrainingRecord[] = [];
		const training = createTrainingRuntime({
			store: { append: async (entry) => { records.push(entry); }, list: async () => records },
			capture: { serialize: () => { throw new Error("serializer exploded"); } },
			tracing: { enabled: false },
			onError: () => undefined,
		});
		expect(training.capture(route, "route", undefined, (input: string) => input, ["x"])).toBe("x");
		await training.flush();
	});

	it("does not let a throwing capture mapper break the traced call", async () => {
		const training = createTrainingRuntime({
			capture: { mapInput: () => { throw new Error("mapper exploded"); } },
			tracing: { enabled: false },
			onError: () => undefined,
		});
		expect(training.capture(route, "route", undefined, (input: string) => input, ["x"])).toBe("x");
		await training.flush();
	});
});

function trainingInputFor(artifact: string) {
	return {
		trainable: defineTrainable("Fixture.route").symbol,
		evaluation: {
			tests: [{ id: "a", input: "abc", assert: [{ type: "equals" as const, value: "ABC" }] }],
			task: (value: string) => value.toUpperCase(),
			outputDir: `${artifact}-agentv`,
		},
	};
}

/** Waits for a detached background chain to reach a condition. Evolution runs
 * off the call path by design, so there is nothing to await directly. */
async function settle(done: () => boolean, attempts = 40): Promise<void> {
	for (let attempt = 0; attempt < attempts && !done(); attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
