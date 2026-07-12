import { appendFile, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
	AgentActionDeniedError,
	FileBusStore,
	createHarnessPolicy,
	defineTrainingHarness,
	dispatchAction,
	MxcSandbox,
	WriteAheadAgentBus,
	type AgentBusEntry,
} from "../src/index.js";

describe("training harness", () => {
	it("uses one callback loop for teacher feedback, judge decisions, and adversarial review", async () => {
		const callbacks = await loopCallbacks(["fail", "pass", "fail"]);
		const student = vi.fn(({ round }) => `candidate-${round}`);
		const adversary = vi.fn(() => "counterexample");
		const harness = defineTrainingHarness<string, string, string>({ maxRounds: 2, candidateId: (candidate) => candidate });

		const result = await harness.run({
			...callbacks,
			task: "optimize candidate",
			rubric: "Candidate must be correct",
			student,
			teacher: () => ({ assessment: "evidence", feedback: ["teacher-only feedback"] }),
			adversary,
			reviseRubric: () => ({ rubric: "unused", feedback: [] }),
		});

		expect(result.outcome).toBe("accepted");
		expect(student.mock.calls[1]?.[0].feedback).toEqual(["teacher-only feedback"]);
		expect(student.mock.calls[1]?.[0].context.length).toBeGreaterThan(0);
		expect(adversary).toHaveBeenCalledOnce();
		expect(result.final.adversary).toEqual({ challenge: "counterexample", decision: "fail" });
		// The judge is just another actor: its verdicts are ordinary messages.
		const judgeEntries = await callbacks.bus.read("judge");
		expect(judgeEntries.length).toBeGreaterThan(0);
		expect(judgeEntries.every(({ kind }) => kind === "agent.decision")).toBe(true);
	});

	it("does not accept when cancellation occurs during the teacher turn", async () => {
		const callbacks = await loopCallbacks(["pass"]);
		const controller = new AbortController();
		const harness = defineTrainingHarness<string, null, string>({ candidateId: (candidate) => candidate });

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
			adversary: () => "challenge",
			reviseRubric: () => ({ rubric: "revised", feedback: [] }),
		})).rejects.toThrow();
	});

	it("forces rubric revision after a judge-approved adversarial challenge", async () => {
		const callbacks = await loopCallbacks(["pass", "pass"]);
		const teacher = vi.fn(() => ({ assessment: "passes", feedback: [] as string[] }));
		const reviseRubric = vi.fn(() => ({ rubric: "Check tests and adversarial edge cases", feedback: ["handle edge case"] }));
		const harness = defineTrainingHarness<string, string, string>({ maxRounds: 1, candidateId: (candidate) => candidate });

		const result = await harness.run({
			...callbacks,
			task: "task",
			rubric: "Check tests",
			student: () => "candidate",
			teacher,
			adversary: (_candidate, turn) => {
				expect(JSON.stringify(turn)).not.toMatch(/teacher|rubric|student/i);
				return "edge-case failure";
			},
			reviseRubric,
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

	it("refuses appends and reads the access hook denies", async () => {
		const bus = new WriteAheadAgentBus({
			allow: (access) => access.operation === "append" ? access.actor !== "intruder" : access.actor === undefined,
		});

		await expect(bus.append({ actor: "student", kind: "test.allowed" })).resolves.toMatchObject({ sequence: 1 });
		await expect(bus.append({ actor: "intruder", kind: "test.blocked" })).rejects.toThrow("refused append");
		await expect(bus.read()).resolves.toHaveLength(1);
		await expect(bus.read("student")).rejects.toThrow("refused read");
	});

	it("accepts any store implementation and resumes its sequence numbering", async () => {
		// A hand-rolled store standing in for memory, disk, or a remote service.
		const remote: AgentBusEntry[] = [];
		const bus = new WriteAheadAgentBus({
			store: {
				append: async (entry) => {
					remote.push(entry);
				},
				load: async () => [...remote],
			},
		});

		await bus.append({ actor: "student", kind: "test.first" });
		remote.push({ ...remote[0]!, sequence: 7 as AgentBusEntry["sequence"] });
		const appended = await bus.append({ actor: "student", kind: "test.second" });
		expect(appended.sequence).toBe(2);
		expect(remote).toHaveLength(3);
	});

	it("hands actors provider-shaped context instead of the raw log", async () => {
		const callbacks = await loopCallbacks(["fail", "pass", "fail"]);
		const contexts: number[] = [];
		const harness = defineTrainingHarness<string, string, string>({ maxRounds: 2, candidateId: (candidate) => candidate });

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
			adversary: () => "challenge",
			reviseRubric: () => ({ rubric: "revised", feedback: [] }),
		});

		// By round two the bus holds many entries; the provider windowed them to one.
		expect(contexts).toEqual([0, 1]);
		expect((await callbacks.bus.read()).length).toBeGreaterThan(1);
	});

	it("continues sequence numbers and recovers an incomplete trailing entry", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ts-autocode-bus-recovery-"));
		const file = join(directory, "actions.jsonl");
		const first = new WriteAheadAgentBus({ store: new FileBusStore(file) });
		await dispatchAction(first, "student", "first", {}, () => "pass", async () => "one");
		const second = new WriteAheadAgentBus({ store: new FileBusStore(file) });
		await dispatchAction(second, "teacher", "second", {}, () => "pass", async () => "two");
		await appendFile(file, "{\"incomplete\"", "utf8");
		expect((await second.read()).map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it("gates sandbox file actions and keeps the bus outside writable workspaces", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "ts-autocode-sandbox-"));
		const { bus } = await newBus();
		const sandbox = new MxcSandbox({
			id: "files",
			workspace,
			policy: createHarnessPolicy({ workspace }),
			bus,
			actor: "student",
			gate: () => "pass",
		});
		expect(await sandbox.uploadFiles([["candidate.ts", new TextEncoder().encode("value")]]))
			.toEqual([{ path: "candidate.ts", error: null }]);
		expect((await bus.read()).map(({ kind }) => kind))
			.toEqual(["sandbox.upload", "agent.decision", "sandbox.upload.completed"]);

		expect(() => new MxcSandbox({
			id: "unsafe",
			workspace,
			policy: createHarnessPolicy({ workspace }),
			bus,
			actor: "student",
			protectedPaths: [join(workspace, "actions.jsonl")],
		})).toThrow("outside the writable sandbox");
	});

	it("refuses symlinked paths that resolve outside the workspace", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "ts-autocode-sandbox-links-"));
		const outside = await mkdtemp(join(tmpdir(), "ts-autocode-outside-"));
		await writeFile(join(outside, "secret.txt"), "secret", "utf8");
		await symlink(outside, join(workspace, "leak"));
		await symlink(join(outside, "secret.txt"), join(workspace, "alias.txt"));
		const { bus } = await newBus();
		const sandbox = new MxcSandbox({ id: "links", workspace, policy: createHarnessPolicy({ workspace }), bus, actor: "student" });

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
