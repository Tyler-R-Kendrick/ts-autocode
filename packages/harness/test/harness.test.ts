import { describe, expect, it, vi } from "vitest";

import { defineTrainingHarness } from "../src/index.js";

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
});
