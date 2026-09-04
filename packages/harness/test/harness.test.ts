import { mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createStorage } from "unstorage";
import fsDriver from "unstorage/drivers/fs";

import {
	AgentActionDeniedError,
	createSandboxPolicy,
	defineTrainingHarness,
	dispatchAction,
	HarnessSandbox,
	inferringHarness,
	WriteAheadAgentBus,
	type AgentBusEntry,
} from "../src/index.js";

describe("training harness", () => {
	it("runs with only a student and a teacher; defaults supply the rest", async () => {
		const harness = defineTrainingHarness<string, string, string>();
		const result = await harness.run({
			task: "task",
			rubric: "rubric",
			student: ({ round }) => `candidate-${round}`,
			teacher: (candidate) => ({ assessment: "evidence", feedback: candidate === "candidate-1" ? ["needs work"] : [] }),
		});

		expect(result.outcome).toBe("accepted");
		expect(result.final.round).toBe(2);
		expect(result.final.adversary).toBeUndefined();
		// The defaulted in-memory bus still carries the full audit log,
		// including evidence-convention verdicts as ordinary judge messages.
		const verdicts = await result.bus.read("judge");
		expect(verdicts).toHaveLength(2);
		expect(verdicts.every(({ kind }) => kind === "agent.decision")).toBe(true);
	});

	it("applies the evidence convention when no judge is configured", async () => {
		const evidence = [["breaks on unicode"], []];
		const harness = defineTrainingHarness<string, string, string>();
		const result = await harness.run({
			task: "task",
			rubric: "Initial rubric",
			student: ({ round }) => `candidate-${round}`,
			teacher: () => ({ assessment: "evidence", feedback: [] }),
			adversary: { challenge: () => ({ challenge: "challenge", feedback: evidence.shift() ?? [] }) },
		});

		// Round one's challenge stood and tightened the rubric by default;
		// round two's challenge found nothing, so the candidate was accepted.
		expect(result.outcome).toBe("accepted");
		expect(result.final.round).toBe(2);
		expect(result.rounds[0]?.rubric).toBe("Initial rubric\nAdversarial criteria: breaks on unicode");
	});

	it("uses one callback loop for teacher feedback, judge decisions, and adversarial review", async () => {
		const callbacks = await loopCallbacks(["fail", "pass", "fail"]);
		const student = vi.fn(({ round }) => `candidate-${round}`);
		const challenge = vi.fn(() => ({ challenge: "counterexample", feedback: [] }));
		const harness = defineTrainingHarness<string, string, string>({ maxRounds: 2 });

		const result = await harness.run({
			...callbacks,
			task: "optimize candidate",
			rubric: "Candidate must be correct",
			student,
			teacher: () => ({ assessment: "evidence", feedback: ["teacher-only feedback"] }),
			adversary: { challenge, reviseRubric: () => ({ rubric: "unused", feedback: [] }) },
		});

		expect(result.outcome).toBe("accepted");
		expect(student.mock.calls[1]?.[0].feedback).toEqual(["teacher-only feedback"]);
		expect(student.mock.calls[1]?.[0].context.length).toBeGreaterThan(0);
		expect(challenge).toHaveBeenCalledOnce();
		expect(result.final.adversary).toEqual({ challenge: "counterexample", decision: "fail" });
		// The judge is just another actor: its verdicts are ordinary messages.
		const judgeEntries = await callbacks.bus.read("judge");
		expect(judgeEntries.length).toBeGreaterThan(0);
		expect(judgeEntries.every(({ kind }) => kind === "agent.decision")).toBe(true);
	});

	it("does not accept when cancellation occurs during the teacher turn", async () => {
		const callbacks = await loopCallbacks(["pass"]);
		const controller = new AbortController();
		const harness = defineTrainingHarness<string, null, string>();

		await expect(harness.run({
			...callbacks,
			task: "task",
			rubric: "rubric",
			signal: controller.signal,
			student: () => "candidate",
			teacher: () => {
				controller.abort();
				return { assessment: null, feedback: [] };
			},
			adversary: { challenge: () => ({ challenge: "challenge", feedback: [] }) },
		})).rejects.toThrow();
	});

	it("forces rubric revision after a judge-approved adversarial challenge", async () => {
		const callbacks = await loopCallbacks(["pass", "pass"]);
		const teacher = vi.fn(() => ({ assessment: "passes", feedback: [] as string[] }));
		const reviseRubric = vi.fn(() => ({ rubric: "Check tests and adversarial edge cases", feedback: ["handle edge case"] }));
		const harness = defineTrainingHarness<string, string, string>({ maxRounds: 1 });

		const result = await harness.run({
			...callbacks,
			task: "task",
			rubric: "Check tests",
			student: () => "candidate",
			teacher,
			adversary: {
				challenge: (_candidate, turn) => {
					expect(JSON.stringify(turn)).not.toMatch(/teacher|rubric|student/i);
					return { challenge: "edge-case failure", feedback: ["handle edge case"] };
				},
				reviseRubric,
			},
		});

		expect(result.outcome).toBe("exhausted");
		expect(result.rubric).toBe("Check tests and adversarial edge cases");
		expect(reviseRubric).toHaveBeenCalledOnce();
	});

	it("records intent, verdict, and outcome in order for gated actions", async () => {
		const { bus } = await newBus();
		const execute = vi.fn(async () => "done");
		await expect(dispatchAction(bus, "student", "test.action", { value: 1 }, () => "pass", execute)).resolves.toBe("done");
		expect((await bus.read()).map(({ actor, kind }) => `${actor}:${kind}`))
			.toEqual(["student:test.action", "judge:agent.decision", "student:test.action.completed"]);
	});

	it("never executes denied actions and records gate failures", async () => {
		const denied = new WriteAheadAgentBus();
		const execute = vi.fn(async () => "forbidden");
		await expect(dispatchAction(denied, "teacher", "test.denied", {}, () => "fail", execute))
			.rejects.toBeInstanceOf(AgentActionDeniedError);
		expect(execute).not.toHaveBeenCalled();
		expect((await denied.read()).map(({ kind }) => kind)).toEqual(["test.denied", "agent.decision"]);

		const failed = new WriteAheadAgentBus();
		await expect(dispatchAction(failed, "student", "test.failure", {}, () => { throw new Error("judge unavailable"); }, execute))
			.rejects.toThrow("judge unavailable");
		expect((await failed.read()).map(({ kind }) => kind)).toEqual(["test.failure", "test.failure.failed"]);
	});

	it("binds an agent writer so entries need only a kind and payload", async () => {
		const bus = new WriteAheadAgentBus();
		const student = bus.agent("student");
		await student("test.note", { value: 1 });
		await student("test.done");

		expect((await bus.read("student")).map(({ actor, kind, payload }) => ({ actor, kind, payload }))).toEqual([
			{ actor: "student", kind: "test.note", payload: { value: 1 } },
			{ actor: "student", kind: "test.done", payload: undefined },
		]);
	});

	it("refuses appends and reads the access hook denies", async () => {
		const bus = new WriteAheadAgentBus({
			allow: (access) => access.operation === "append" ? access.actor !== "intruder" : access.actor === undefined,
		});

		await expect(bus.append({ actor: "student", kind: "test.allowed" })).resolves.toMatchObject({ sequence: 1 });
		await expect(bus.append({ actor: "intruder", kind: "test.blocked" })).rejects.toThrow("refused append");
		await expect(bus.read()).resolves.toHaveLength(1);
		await expect(bus.read("student")).rejects.toThrow("refused read");
	});

	it("accepts any unstorage driver and resumes its sequence numbering", async () => {
		// The memory driver stands in for fs, redis, or any other driver.
		const storage = createStorage();
		const first = new WriteAheadAgentBus({ storage });
		const initial = await first.append({ actor: "student", kind: "test.first" });
		// Another writer advanced the shared log; a new bus resumes behind it.
		await storage.setItem("entry:7", { ...initial, sequence: 7 });
		const appended = await new WriteAheadAgentBus({ storage }).append({ actor: "student", kind: "test.second" });
		expect(appended.sequence).toBe(8);
		expect(await storage.getKeys("entry")).toHaveLength(3);
	});

	it("hands actors provider-shaped context instead of the raw log", async () => {
		const callbacks = await loopCallbacks(["fail", "pass", "fail"]);
		const contexts: number[] = [];
		const harness = defineTrainingHarness<string, string, string>({ maxRounds: 2 });

		await harness.run({
			...callbacks,
			contextProvider: (entries) => entries.slice(-1),
			task: "task",
			rubric: "rubric",
			student: ({ round, context }) => {
				contexts.push(context.length);
				return `candidate-${round}`;
			},
			teacher: () => ({ assessment: "evidence", feedback: [] }),
			adversary: {
				challenge: () => ({ challenge: "challenge", feedback: [] }),
				reviseRubric: () => ({ rubric: "revised", feedback: [] }),
			},
		});

		// By round two the bus holds many entries; the provider windowed them to one.
		expect(contexts).toEqual([0, 1]);
		expect((await callbacks.bus.read()).length).toBeGreaterThan(1);
	});

	it("persists through the fs driver and continues sequence numbers across buses", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ts-autocode-bus-fs-"));
		const first = new WriteAheadAgentBus({ storage: createStorage({ driver: fsDriver({ base: directory }) }) });
		await dispatchAction(first, "student", "first", {}, () => "pass", async () => "one");
		const second = new WriteAheadAgentBus({ storage: createStorage({ driver: fsDriver({ base: directory }) }) });
		await dispatchAction(second, "teacher", "second", {}, () => "pass", async () => "two");
		expect((await second.read()).map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it("gates sandbox file actions and keeps the bus outside writable paths", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "ts-autocode-sandbox-"));
		const { bus } = await newBus();
		// No policy configured: the sandbox falls back to the default policy.
		const sandbox = new HarnessSandbox({
			id: "files",
			workspace,
			bus,
			actor: "student",
			gate: () => "pass",
		});
		expect(await sandbox.uploadFiles([["candidate.ts", new TextEncoder().encode("value")]]))
			.toEqual([{ path: "candidate.ts", error: null }]);
		expect((await bus.read()).map(({ kind }) => kind))
			.toEqual(["sandbox.upload", "agent.decision", "sandbox.upload.completed"]);

		expect(() => new HarnessSandbox({
			id: "unsafe",
			workspace,
			bus,
			actor: "student",
			protectedPaths: [join(workspace, "actions.jsonl")],
		})).toThrow("outside every writable sandbox path");
	});

	it("accepts consumer-configured policies and protects paths against them", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "ts-autocode-sandbox-custom-"));
		const scratch = await mkdtemp(join(tmpdir(), "ts-autocode-scratch-"));
		const { bus } = await newBus();
		// A policy the default would never produce: an extra writable root and
		// unrestricted outbound network access.
		const policy = {
			...createSandboxPolicy({ workspace }),
			filesystem: { readwritePaths: [workspace, scratch] },
			network: { allowOutbound: true, allowLocalNetwork: false },
		};

		expect(() => new HarnessSandbox({ id: "custom", workspace, policy, bus, actor: "student" })).not.toThrow();
		expect(() => new HarnessSandbox({
			id: "custom-unsafe",
			workspace,
			policy,
			bus,
			actor: "student",
			protectedPaths: [join(scratch, "actions.jsonl")],
		})).toThrow("outside every writable sandbox path");
	});

	it("defaults the policy version to the installed mxc-sdk release", () => {
		const { version } = createRequire(import.meta.url)("@microsoft/mxc-sdk/package.json") as { version: string };
		expect(createSandboxPolicy({ workspace: tmpdir() }).version).toBe(version);
		expect(createSandboxPolicy({ workspace: tmpdir(), version: "0.6.0-alpha" }).version).toBe("0.6.0-alpha");
	});

	// The policy builder is the whole of the default confinement story, and only
	// its `version` field was ever asserted. Every other branch -- the outbound
	// allowlist above all -- decides what a model-driven agent can reach.
	describe("the default policy it builds", () => {
		it("confines writes to the workspace and denies the network outright", () => {
			const policy = createSandboxPolicy({ workspace: tmpdir() });
			expect(policy.filesystem).toEqual({ readwritePaths: [tmpdir()] });
			expect(policy.network).toEqual({ allowOutbound: false, allowLocalNetwork: false });
			expect(policy.ui).toEqual({ allowWindows: false, clipboard: "none", allowInputInjection: false });
			expect(policy.timeoutMs).toBeUndefined();
		});

		it("adds readonly paths only when some were given", () => {
			const readonlyPaths = [tmpdir(), resolve(tmpdir(), "vendor")];
			expect(createSandboxPolicy({ workspace: tmpdir(), readonlyPaths }).filesystem?.readonlyPaths)
				.toEqual(readonlyPaths);
			expect(createSandboxPolicy({ workspace: tmpdir(), readonlyPaths: [] }).filesystem)
				.not.toHaveProperty("readonlyPaths");
		});

		it("copies the readonly paths rather than aliasing the caller's array", () => {
			const readonlyPaths = [resolve(tmpdir(), "vendor")];
			const policy = createSandboxPolicy({ workspace: tmpdir(), readonlyPaths });
			readonlyPaths.push(resolve(tmpdir(), "smuggled"));
			expect(policy.filesystem?.readonlyPaths).toEqual([resolve(tmpdir(), "vendor")]);
		});

		it("opens outbound access only for the hosts it was given, never the local network", () => {
			const policy = createSandboxPolicy({ workspace: tmpdir(), allowedHosts: ["api.openai.com"] });
			expect(policy.network).toEqual({
				allowOutbound: true,
				allowLocalNetwork: false,
				allowedHosts: ["api.openai.com"],
			});
		});

		it("copies the allowed hosts rather than aliasing the caller's array", () => {
			const allowedHosts = ["api.openai.com"];
			const policy = createSandboxPolicy({ workspace: tmpdir(), allowedHosts });
			allowedHosts.push("evil.example");
			expect(policy.network).toMatchObject({ allowedHosts: ["api.openai.com"] });
		});

		it("keeps the network closed when the allowlist is empty or only blanks", () => {
			// An allowlist that filters down to nothing must fail closed. Reading
			// it as "no restrictions" would open the network on a typo.
			for (const allowedHosts of [[], ["", "   "]]) {
				expect(createSandboxPolicy({ workspace: tmpdir(), allowedHosts }).network)
					.toEqual({ allowOutbound: false, allowLocalNetwork: false });
			}
		});

		it("drops blank entries from an otherwise real allowlist", () => {
			expect(createSandboxPolicy({ workspace: tmpdir(), allowedHosts: ["api.openai.com", "  "] }).network)
				.toMatchObject({ allowedHosts: ["api.openai.com"] });
		});

		it("carries a timeout only when one was configured", () => {
			expect(createSandboxPolicy({ workspace: tmpdir(), timeoutMs: 30_000 }).timeoutMs).toBe(30_000);
			expect(createSandboxPolicy({ workspace: tmpdir() })).not.toHaveProperty("timeoutMs");
		});

		it.each([
			["a relative workspace", { workspace: "relative/path" }],
			["a relative readonly path", { workspace: tmpdir(), readonlyPaths: ["relative/path"] }],
		])("refuses %s rather than building a policy around it", (_label, settings) => {
			expect(() => createSandboxPolicy(settings as Parameters<typeof createSandboxPolicy>[0])).toThrow();
		});

		it.each([
			["zero", 0],
			["negative", -1],
			["fractional", 1.5],
		])("refuses a %s timeout, saying what a timeout must be", (_label, timeoutMs) => {
			expect(() => createSandboxPolicy({ workspace: tmpdir(), timeoutMs }))
				.toThrow(/timeoutMs must be a positive integer/);
		});
	});

	it("refuses symlinked paths that resolve outside the workspace", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "ts-autocode-sandbox-links-"));
		const outside = await mkdtemp(join(tmpdir(), "ts-autocode-outside-"));
		await writeFile(join(outside, "secret.txt"), "secret", "utf8");
		await symlink(outside, join(workspace, "leak"));
		await symlink(join(outside, "secret.txt"), join(workspace, "alias.txt"));
		const { bus } = await newBus();
		const sandbox = new HarnessSandbox({ id: "links", workspace, bus, actor: "student" });

		expect(await sandbox.downloadFiles(["leak/secret.txt", "alias.txt"])).toEqual([
			{ path: "leak/secret.txt", content: null, error: "file_not_found" },
			{ path: "alias.txt", content: null, error: "file_not_found" },
		]);
		expect(await sandbox.uploadFiles([
			["leak/implant.txt", new TextEncoder().encode("x")],
			["alias.txt", new TextEncoder().encode("x")],
		])).toEqual([
			{ path: "leak/implant.txt", error: "permission_denied" },
			{ path: "alias.txt", error: "permission_denied" },
		]);
		await expect(readFile(join(outside, "implant.txt"))).rejects.toThrow();
		expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("secret");

		expect(await sandbox.uploadFiles([["leak/sub/nested.txt", new TextEncoder().encode("x")]]))
			.toEqual([{ path: "leak/sub/nested.txt", error: "permission_denied" }]);
		await expect(stat(join(outside, "sub"))).rejects.toThrow();
	});
});

async function newBus() {
	return { bus: new WriteAheadAgentBus() };
}

async function loopCallbacks(decisions: readonly ("pass" | "fail")[]) {
	const bus = new WriteAheadAgentBus();
	let decision = 0;
	return {
		bus,
		judge: vi.fn((input: unknown) => {
			const request = input as { subject: string };
			return request.subject === "action" ? "pass" as const : decisions[decision++] ?? "fail";
		}),
	};
}

describe("inferringHarness", () => {
	// defineTrainingHarness takes three type parameters but `settings` mentions
	// only TCandidate, so a bare call inferred `unknown, unknown, unknown` and
	// every documented call site wrote all three out. TChallenge was already
	// scoped to `run` and inferred; these two now behave the same way.
	it("infers assessment and feedback from the roles", async () => {
		const result = await inferringHarness<{ id: string }>().run({
			task: "task",
			rubric: "rubric",
			student: ({ round }) => ({ id: `candidate-${round}` }),
			teacher: (candidate) => ({
				assessment: { score: candidate.id === "candidate-1" ? 0 : 1 },
				feedback: candidate.id === "candidate-1" ? ["needs work"] : [],
			}),
		});

		expect(result.outcome).toBe("accepted");
		expect(result.final.candidate.id).toBe("candidate-2");
		// Inferred, not asserted: `assessment` is {score: number} here, so this
		// arithmetic typechecks without a cast or an explicit type argument.
		expect(result.final.assessment.score + 1).toBe(2);
	});

	it("still honors settings", async () => {
		const result = await inferringHarness<string>({ maxRounds: 1 }).run({
			task: "task",
			rubric: "rubric",
			student: ({ round }) => `candidate-${round}`,
			teacher: () => ({ assessment: "no", feedback: ["always rejected"] }),
		});
		expect(result.outcome).toBe("exhausted");
		expect(result.rounds).toHaveLength(1);
	});
});
