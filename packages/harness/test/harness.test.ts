import { appendFile, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
	AgentActionDeniedError,
	createHarnessPolicy,
	createTrainingAgents,
	defineTrainingHarness,
	MxcSandbox,
	parseJudgeDecision,
	WriteAheadAgentBus,
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
		expect((await callbacks.bus.context("judge")).every(({ kind }) => kind === "agent.decide")).toBe(true);
		expect((await callbacks.bus.context("judge")).length).toBeGreaterThan(0);
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

	it("writes, syncs, approves, and completes actions in order", async () => {
		const { bus } = await approvedBus();
		const execute = vi.fn(async () => "done");
		await expect(bus.dispatch("student", "test.action", { value: 1 }, execute)).resolves.toBe("done");
		expect((await bus.context()).map(({ phase }) => phase)).toEqual(["proposed", "approved", "completed"]);
	});

	it("never executes denied actions and records judge failures", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ts-autocode-bus-deny-"));
		const denied = new WriteAheadAgentBus({ file: join(directory, "denied.jsonl") });
		const execute = vi.fn(async () => "forbidden");
		denied.setJudge(() => "fail");
		await expect(denied.dispatch("teacher", "test.denied", {}, execute)).rejects.toBeInstanceOf(AgentActionDeniedError);
		expect(execute).not.toHaveBeenCalled();

		const failed = new WriteAheadAgentBus({ file: join(directory, "failed.jsonl") });
		failed.setJudge(() => { throw new Error("judge unavailable"); });
		await expect(failed.dispatch("student", "test.failure", {}, execute)).rejects.toThrow("judge unavailable");
		expect((await failed.context()).map(({ phase }) => phase)).toEqual(["proposed", "failed"]);
	});

	it("continues sequence numbers and recovers an incomplete trailing entry", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ts-autocode-bus-recovery-"));
		const file = join(directory, "actions.jsonl");
		const first = new WriteAheadAgentBus({ file });
		first.setJudge(() => "pass");
		await first.dispatch("student", "first", {}, async () => "one");
		const second = new WriteAheadAgentBus({ file });
		second.setJudge(() => "pass");
		await second.dispatch("teacher", "second", {}, async () => "two");
		await appendFile(file, "{\"incomplete\"", "utf8");
		expect((await second.context()).map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it("accepts arbitrary judge input and only exact pass or fail output", () => {
		expect(parseJudgeDecision("pass")).toBe("pass");
		expect(parseJudgeDecision({ messages: [{ content: "PASS" }] })).toBe("pass");
		expect(parseJudgeDecision({ messages: [{ content: [{ type: "text", text: "fail" }] }] })).toBe("fail");
		expect(() => parseJudgeDecision({ messages: [{ content: "fail, because" }] })).toThrow("exactly pass or fail");
	});

	it("gates sandbox file actions and keeps the bus outside writable workspaces", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "ts-autocode-sandbox-"));
		const { bus } = await approvedBus();
		const sandbox = new MxcSandbox({ id: "files", workspace, policy: createHarnessPolicy({ workspace }), bus, role: "student" });
		expect(await sandbox.uploadFiles([["candidate.ts", new TextEncoder().encode("value")]]))
			.toEqual([{ path: "candidate.ts", error: null }]);
		expect((await bus.context()).filter(({ kind }) => kind === "sandbox.upload").map(({ phase }) => phase))
			.toEqual(["proposed", "approved", "completed"]);

		const unsafe = new WriteAheadAgentBus({ file: join(workspace, "actions.jsonl") });
		expect(() => new MxcSandbox({ id: "unsafe", workspace, policy: createHarnessPolicy({ workspace }), bus: unsafe, role: "student" }))
			.toThrow("outside the writable sandbox");
	});

	it("refuses symlinked paths that resolve outside the workspace", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "ts-autocode-sandbox-links-"));
		const outside = await mkdtemp(join(tmpdir(), "ts-autocode-outside-"));
		await writeFile(join(outside, "secret.txt"), "secret", "utf8");
		await symlink(outside, join(workspace, "leak"));
		await symlink(join(outside, "secret.txt"), join(workspace, "alias.txt"));
		const { bus } = await approvedBus();
		const sandbox = new MxcSandbox({ id: "links", workspace, policy: createHarnessPolicy({ workspace }), bus, role: "student" });

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
	});

	it("creates configurable Deep Agent callbacks for the same run model", async () => {
		const root = await mkdtemp(join(tmpdir(), "ts-autocode-agents-"));
		const role = (name: string) => {
			const workspace = join(root, name);
			return { sandbox: { id: name, workspace, policy: createHarnessPolicy({ workspace }) }, systemPrompt: `${name} prompt` };
		};
		const callbacks = createTrainingAgents({
			bus: { file: join(root, "actions.jsonl") },
			student: role("student"), teacher: role("teacher"), judge: role("judge"), adversary: role("adversary"),
			outputs: {
				student: () => "candidate",
				teacher: () => ({ assessment: "evidence", feedback: [] }),
				adversary: () => "challenge",
				revision: () => ({ rubric: "revised", feedback: [] }),
			},
		});
		expect(callbacks.student).toBeTypeOf("function");
		expect(callbacks.teacher).toBeTypeOf("function");
		expect(callbacks.judge).toBeTypeOf("function");
		expect(callbacks.adversary).toBeTypeOf("function");
		expect(callbacks.reviseRubric).toBeTypeOf("function");
	});
});

async function approvedBus() {
	const directory = await mkdtemp(join(tmpdir(), "ts-autocode-bus-"));
	const bus = new WriteAheadAgentBus({ file: join(directory, "actions.jsonl") });
	bus.setJudge(() => "pass");
	return { bus, directory };
}

async function loopCallbacks(decisions: readonly ("pass" | "fail")[]) {
	const directory = await mkdtemp(join(tmpdir(), "ts-autocode-loop-"));
	const bus = new WriteAheadAgentBus({ file: join(directory, "actions.jsonl") });
	let decision = 0;
	return {
		bus,
		judge: vi.fn((input: unknown) => {
			const request = input as { subject: string };
			return request.subject === "action" ? "pass" as const : decisions[decision++] ?? "fail";
		}),
	};
}
