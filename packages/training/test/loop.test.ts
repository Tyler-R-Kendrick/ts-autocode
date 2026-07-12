import { describe, expect, it } from "vitest";

import {
	sequentialLoop,
	trainingRounds,
	type CandidatePatch,
	type CandidateReview,
	type TrainingLoopInput,
	type TrainingRound,
} from "../src/index.js";
import { discoverInSource } from "../src/source.js";

const target = discoverInSource(`class Router {
  route(input: string): string {
    "use training";
    return input;
  }
}`, "src/router.ts")[0]!;

function candidate(id: string): CandidatePatch {
	return { id, trainableId: target.id, engineId: "loop-test", target, implementation: "return input;" };
}

function review(candidateId: string, promote: boolean, meanScore = promote ? 1 : 0): CandidateReview {
	return {
		verification: {} as never,
		decision: {
			candidateId,
			promote,
			failures: promote ? [] : [`rejected ${candidateId}`],
			meanScore,
			passRate: promote ? 1 : 0,
		},
	};
}

function loopInput(
	overrides: Partial<TrainingLoopInput> & Pick<TrainingLoopInput, "propose" | "review">,
): TrainingLoopInput {
	return { trainableId: target.id, objective: "test", rubric: "test", outputDir: "test/output/loop", ...overrides };
}

describe("training loop fan-out", () => {
	it("fans out up to the configured number of concurrent candidate pipelines", async () => {
		let active = 0;
		let maxActive = 0;
		let release!: () => void;
		const rendezvous = new Promise<void>((resolve) => { release = resolve; });
		const run = await sequentialLoop(loopInput({
			fanOut: 3,
			maxRounds: 1,
			propose: async ({ round, slot }) => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				if (active >= 3) release();
				await Promise.race([rendezvous, new Promise((resolve) => setTimeout(resolve, 2000))]);
				active -= 1;
				return candidate(`round-${round}-slot-${slot}`);
			},
			review: async (patch) => review(patch.id, false),
		}));

		expect(maxActive).toBe(3);
		expect(run.outcome).toBe("exhausted");
		expect(run.rounds).toHaveLength(3);
		expect(run.rounds.every((entry) => entry.round === 1)).toBe(true);
	});

	it("aggregates a round's failures into the next round's feedback and emits the winner last", async () => {
		const feedbackSeen: string[][] = [];
		const run = await sequentialLoop(loopInput({
			fanOut: 2,
			propose: async ({ round, slot, feedback }) => {
				feedbackSeen.push([...feedback]);
				return candidate(`round-${round}-slot-${slot}`);
			},
			review: async (patch) => review(patch.id, patch.id === "round-2-slot-2"),
		}));

		expect(run.outcome).toBe("ready");
		expect(run.rounds).toHaveLength(4);
		expect(run.rounds.at(-1)?.candidate.id).toBe("round-2-slot-2");
		expect(feedbackSeen[2]).toEqual(["rejected round-1-slot-1", "rejected round-1-slot-2"]);
	});

	it("picks the highest-scoring candidate when several pass the gate", async () => {
		const run = await sequentialLoop(loopInput({
			fanOut: 2,
			propose: async ({ slot }) => candidate(`slot-${slot}`),
			review: async (patch) => review(patch.id, true, patch.id === "slot-1" ? 0.9 : 0.95),
		}));

		expect(run.outcome).toBe("ready");
		expect(run.rounds).toHaveLength(2);
		expect(run.rounds.at(-1)?.candidate.id).toBe("slot-2");
	});

	it("skips duplicate proposals and stalls when a round reviews nothing new", async () => {
		let reviews = 0;
		const run = await sequentialLoop(loopInput({
			fanOut: 2,
			propose: async () => candidate("same"),
			review: async (patch) => {
				reviews += 1;
				return review(patch.id, false);
			},
		}));

		expect(run.outcome).toBe("stalled");
		expect(reviews).toBe(1);
		expect(run.rounds).toHaveLength(1);
	});
});

describe("observable round sequence", () => {
	it("emits each reviewed round in order before completing", async () => {
		const emitted: Array<TrainingRound | string> = [];
		const labels: string[] = [];
		await new Promise<void>((resolve) => {
			trainingRounds(loopInput({
				maxRounds: 2,
				propose: async ({ round }) => candidate(`candidate-${round}`),
				review: async (patch, { label }) => {
					labels.push(label);
					return review(patch.id, patch.id === "candidate-2");
				},
			})).subscribe({
				next: (round) => emitted.push(round),
				complete: (outcome) => {
					emitted.push(outcome);
					resolve();
				},
			});
		});

		expect(emitted.map((entry) => typeof entry === "string" ? entry : entry.candidate.id))
			.toEqual(["candidate-1", "candidate-2", "ready"]);
		// Without fan-out, review labels keep the sequential naming.
		expect(labels).toEqual(["candidate-1", "candidate-2"]);
	});

	it("propagates the caller's abort into in-flight work", async () => {
		const controller = new AbortController();
		const errored = new Promise<unknown>((resolve) => {
			trainingRounds(loopInput({
				signal: controller.signal,
				propose: ({ signal }) => new Promise((_, reject) => {
					const cancel = () => reject(new Error("cancelled"));
					if (signal?.aborted) cancel();
					else signal?.addEventListener("abort", cancel, { once: true });
				}),
				review: async (patch) => review(patch.id, false),
			})).subscribe({ error: resolve });
		});

		controller.abort();
		expect(await errored).toBeDefined();
	});

	it("aborts in-flight work on unsubscribe and emits nothing afterwards", async () => {
		const events: string[] = [];
		let sawAbort!: () => void;
		const aborted = new Promise<void>((resolve) => { sawAbort = resolve; });
		const unsubscribe = trainingRounds(loopInput({
			propose: ({ signal }) => new Promise((_, reject) => {
				signal?.addEventListener("abort", () => {
					sawAbort();
					reject(new Error("aborted"));
				});
			}),
			review: async (patch) => review(patch.id, false),
		})).subscribe({
			next: () => events.push("next"),
			complete: () => events.push("complete"),
			error: () => events.push("error"),
		});

		unsubscribe();
		await aborted;
		expect(events).toEqual([]);
	});
});
