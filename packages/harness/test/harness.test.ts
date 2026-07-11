import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createHarnessPolicy, createTrainingAgents, defineTrainingHarness, MxcSandbox } from "../src/index.js";
import type { TrainingAgents } from "../src/index.js";

describe("student/teacher training harness", () => {
	it("feeds teacher feedback into the next student round", async () => {
		const student = vi.fn(({ round }) => round === 1 ? "draft" : "accepted");
		const teacher = vi.fn((candidate: string) => ({
			accepted: candidate === "accepted",
			assessment: { candidate },
			feedback: candidate === "accepted" ? [] : ["fix the draft"],
		}));
		const harness = defineTrainingHarness<string, { candidate: string }, string>({
			candidateId: (candidate) => candidate,
		});

		const result = await harness.run({ student, teacher });

		expect(result.outcome).toBe("accepted");
		expect(result.rounds).toHaveLength(2);
		expect(student.mock.calls[1]?.[0].feedback).toEqual(["fix the draft"]);
		expect(result.final.candidate).toBe("accepted");
	});

	it("stops when the student repeats a rejected candidate", async () => {
		const student = vi.fn(() => "same");
		const teacher = vi.fn(() => ({ accepted: false, assessment: null, feedback: ["retry"] }));
		const harness = defineTrainingHarness<string, null, string>({ candidateId: (candidate) => candidate });

		const result = await harness.run({
			student,
			teacher,
		});

		expect(result.outcome).toBe("stalled");
		expect(result.rounds).toHaveLength(1);
		expect(student).toHaveBeenCalledTimes(2);
		expect(teacher).toHaveBeenCalledOnce();
	});

	it("creates default-deny MXC policy", () => {
		const workspace = join(tmpdir(), "training");
		const policy = createHarnessPolicy({ workspace });

		expect(policy.filesystem?.readwritePaths).toEqual([workspace]);
		expect(policy.network).toEqual({ allowOutbound: false, allowLocalNetwork: false });
		expect(policy.ui).toEqual({ allowWindows: false, clipboard: "none", allowInputInjection: false });
	});

	it("keeps file transfer inside the sandbox workspace", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "ts-autocode-harness-"));
		const sandbox = new MxcSandbox({ id: "files", workspace, policy: createHarnessPolicy({ workspace }) });

		expect(await sandbox.uploadFiles([["candidate.ts", new TextEncoder().encode("export const value = 1;")]]))
			.toEqual([{ path: "candidate.ts", error: null }]);
		expect(new TextDecoder().decode((await sandbox.downloadFiles(["candidate.ts"]))[0]?.content ?? undefined))
			.toBe("export const value = 1;");
		expect((await sandbox.uploadFiles([["../escape.ts", new Uint8Array()]]))[0]?.error).toBe("permission_denied");
	});

	it("rejects permissive sandbox policy", () => {
		const workspace = join(tmpdir(), "training-policy");
		expect(() => new MxcSandbox({
			id: "unsafe",
			workspace,
			policy: { version: "0.7.0-alpha", filesystem: { readwritePaths: [workspace, tmpdir()] } },
		})).toThrow("write access only");
	});

	it("builds student and teacher as Deep Agents", () => {
		const workspace = join(tmpdir(), "training-agents");
		const sandbox = { id: "agent", workspace, policy: createHarnessPolicy({ workspace }) };
		const agents = createTrainingAgents({ student: { ...sandbox, id: "student" }, teacher: { ...sandbox, id: "teacher" } });

		expect(agents.student.invoke).toBeTypeOf("function");
		expect(agents.teacher.invoke).toBeTypeOf("function");
		expect(agents.student).not.toBe(agents.teacher);
	});

	it("coordinates Deep Agent student and teacher turns", async () => {
		const student = { invoke: vi.fn(async () => ({ structuredResponse: "candidate" })) };
		const teacher = { invoke: vi.fn(async () => ({ structuredResponse: { accepted: true } })) };
		const harness = defineTrainingHarness<string, string, string>({ candidateId: (candidate) => candidate });

		const result = await harness.runAgents({
			agents: { student, teacher } as unknown as TrainingAgents,
			student: { prompt: () => "improve", output: (run) => (run as { structuredResponse: string }).structuredResponse },
			teacher: {
				prompt: (candidate) => `evaluate ${candidate}`,
				output: () => ({ accepted: true, assessment: "approved", feedback: [] }),
			},
		});

		expect(result.outcome).toBe("accepted");
		expect(student.invoke).toHaveBeenCalledOnce();
		expect(teacher.invoke).toHaveBeenCalledOnce();
	});
});
