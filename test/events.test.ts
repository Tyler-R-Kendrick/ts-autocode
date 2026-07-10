import { describe, expect, it } from "vitest";

import {
	createTrainingEvent,
	hashTrajectory,
	replayTrainingRun,
	validateTrainingEvent,
} from "../src/index.js";
import { makeTrajectory } from "./fixtures.js";

const trajectory = makeTrajectory({
	id: "t-1",
	input: "billing invoice",
	baselineLabel: "general-support",
	expectedLabel: "billing-support",
});

describe("createTrainingEvent / validateTrainingEvent", () => {
	it("builds a valid envelope with correlated subject and stream", () => {
		const event = createTrainingEvent({
			id: "run-1-started",
			type: "training.RunStarted",
			runId: "run-1",
			seq: 0,
		});

		expect(event.subject).toBe("training/run-1");
		expect(event.streamId).toBe("training:run-1");
		expect(validateTrainingEvent(event).ok).toBe(true);
	});

	it("rejects an envelope whose subject does not correlate to the run", () => {
		const event = {
			...createTrainingEvent({ id: "run-1-started", type: "training.RunStarted", runId: "run-1", seq: 0 }),
			subject: "training/other-run",
		};

		const result = validateTrainingEvent(event);
		expect(result.ok).toBe(false);
		expect(result.errors).toContain("event.subject must correlate to event.data.runId");
	});

	it("verifies the trajectory hash on TrajectoryCaptured", () => {
		const good = createTrainingEvent({
			id: "run-1-captured",
			type: "training.TrajectoryCaptured",
			runId: "run-1",
			seq: 1,
			data: { trajectoryId: trajectory.id, trajectoryHash: hashTrajectory(trajectory), trajectory },
		});
		expect(validateTrainingEvent(good).ok).toBe(true);

		const tampered = createTrainingEvent({
			id: "run-1-captured",
			type: "training.TrajectoryCaptured",
			runId: "run-1",
			seq: 1,
			data: { trajectoryId: trajectory.id, trajectoryHash: `sha256:${"0".repeat(64)}`, trajectory },
		});
		const result = validateTrainingEvent(tampered);
		expect(result.ok).toBe(false);
		expect(result.errors).toContain("TrajectoryCaptured.trajectoryHash must match trajectory");
	});

	it("requires a reason on Rejected and a promotionRef on Promoted", () => {
		const rejected = validateTrainingEvent(
			createTrainingEvent({
				id: "run-1-rejected",
				type: "training.Rejected",
				runId: "run-1",
				seq: 5,
				data: { candidateId: "candidate-1" },
			}),
		);
		expect(rejected.ok).toBe(false);
		expect(rejected.errors).toContain("Rejected.reason must be a non-empty string");

		const promoted = validateTrainingEvent(
			createTrainingEvent({
				id: "run-1-promoted",
				type: "training.Promoted",
				runId: "run-1",
				seq: 5,
				data: { candidateId: "candidate-1" },
			}),
		);
		expect(promoted.ok).toBe(false);
		expect(promoted.errors).toContain("Promoted.promotionRef must be a non-empty string");
	});
});

describe("replayTrainingRun", () => {
	it("rebuilds run state from the event log alone", () => {
		const events = [
			createTrainingEvent({ id: "e-0", type: "training.RunStarted", runId: "run-1", seq: 0 }),
			createTrainingEvent({
				id: "e-1",
				type: "training.TrajectoryCaptured",
				runId: "run-1",
				seq: 1,
				data: { trajectoryId: trajectory.id, trajectoryHash: hashTrajectory(trajectory), trajectory },
			}),
			createTrainingEvent({
				id: "e-2",
				type: "training.RewardObserved",
				runId: "run-1",
				seq: 2,
				data: { trajectoryId: trajectory.id, reward: trajectory.reward },
			}),
			createTrainingEvent({
				id: "e-3",
				type: "training.Promoted",
				runId: "run-1",
				seq: 3,
				data: { candidateId: "candidate-1", promotionRef: "promotion://run-1/candidate-1" },
			}),
		];

		// Deliver out of order: replay must sort by seq.
		const projection = replayTrainingRun([events[3]!, events[0]!, events[2]!, events[1]!]);

		expect(projection).toEqual({
			runId: "run-1",
			status: "promoted",
			trajectoryIds: [trajectory.id],
			rewardCount: 1,
			candidateIds: ["candidate-1"],
			lastSeq: 3,
		});
	});

	it("throws on the first invalid event", () => {
		const bad = {
			...createTrainingEvent({ id: "e-0", type: "training.RunStarted", runId: "run-1", seq: 0 }),
			streamId: "training:wrong",
		};

		expect(() => replayTrainingRun([bad])).toThrowError(/invalid training event e-0/);
	});
});
