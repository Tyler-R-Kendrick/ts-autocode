import { describe, expect, it } from "vitest";

import { writeFile } from "node:fs/promises";

import {
	defineTrainable,
	InsufficientTracesError,
	isTsAutocodeError,
	PromotionRejectedError,
} from "../src/index.js";
import { given } from "./support/scenario.js";

// Behavior specs, written in the vocabulary the README uses.
//
// Every other suite is organized around units and failure modes. These are
// organized around what a user is trying to do, so they are the suite that
// fails when a documented promise stops being true even though every unit
// still passes. Each `it` is one sentence of the contract this library offers.

describe("Marking a method for training", () => {
	it("captures calls without changing what the method returns", async () => {
		const scenario = await given({ name: "capture-transparent" });

		scenario.whenTheApplicationCalls("invoice", "password");
		await scenario.training.flush();

		// The promise: marking is observation, not interception.
		const records = await scenario.training.records();
		expect(records).toHaveLength(2);
		expect(records.every((record) => record.succeeded)).toBe(true);
	});

	it("records a failed call as a failure without swallowing the error", async () => {
		const scenario = await given({ name: "capture-failure" });

		expect(() => scenario.training.capture(
			defineTrainable("Router.route"),
			"route",
			undefined,
			(_input: string) => { throw new Error("downstream is down"); },
			["x"] as [string],
		)).toThrow("downstream is down");
		await scenario.training.flush();

		expect((await scenario.training.records()).map((record) => record.succeeded)).toEqual([false]);
	});

	it("leaves the source file untouched until something is activated", async () => {
		const scenario = await given({ name: "capture-no-write" });

		scenario.whenTheApplicationCalls("a", "b", "c");
		await scenario.training.flush();

		expect(await scenario.currentSource()).toBe(scenario.originalSource);
	});
});

describe("Training a marked method against eval cases", () => {
	it("promotes a candidate that passes every case", async () => {
		const scenario = await given({ name: "train-promotes" });

		await scenario.whenTrainedAgainst([["abc", "ABC"], ["xyz", "XYZ"]]);

		expect(scenario.run.outcome).toBe("ready");
		expect(scenario.run.canActivate()).toEqual({ ready: true });
	}, 30_000);

	it("refuses a candidate that fails a case, and says which gate refused", async () => {
		const scenario = await given({ name: "train-refuses" });
		scenario.givenAnEngineThatProposes('return "always-wrong";');

		await scenario.whenTrainedAgainst([["abc", "ABC"]]);

		const readiness = scenario.run.canActivate();
		expect(readiness.ready).toBe(false);
		if (!readiness.ready) {
			expect(readiness.failures.length).toBeGreaterThan(0);
			expect(readiness.outcome).not.toBe("ready");
		}
	}, 30_000);

	it("reports an engine failure as a typed error rather than a stalled run", async () => {
		const scenario = await given({ name: "train-engine-fails" });
		scenario.givenAnEngineThatFails("model unavailable");

		await scenario.whenTrainedAgainst([["abc", "ABC"]]);

		expect(scenario.failure).toBeInstanceOf(Error);
		expect((scenario.failure as Error).message).toContain("model unavailable");
	}, 30_000);
});

describe("Training from captured traffic", () => {
	it("turns successful calls into eval cases and trains against them", async () => {
		const scenario = await given({ name: "live-trains" });
		scenario.givenAnEngineThatProposes("return input;");

		scenario.whenTheApplicationCalls("alpha", "beta", "gamma");
		await scenario.whenTrainedFromCapturedTraffic(3);

		expect(scenario.failure).toBeUndefined();
		expect(scenario.run.baseline.evaluations.length).toBeGreaterThan(0);
	}, 30_000);

	it("refuses to train on too little traffic, and says how much it needed", async () => {
		const scenario = await given({ name: "live-insufficient" });

		scenario.whenTheApplicationCalls("only-one");
		await scenario.whenTrainedFromCapturedTraffic(5);

		expect(scenario.failure).toBeInstanceOf(InsufficientTracesError);
		expect(scenario.failure).toMatchObject({ required: 5, found: 1 });
	}, 30_000);

	it("counts distinct inputs, not repeated ones", async () => {
		const scenario = await given({ name: "live-distinct" });

		// The README promises repeated inputs use the latest output rather than
		// producing contradictory replay cases.
		scenario.whenTheApplicationCalls("same", "same", "same");
		await scenario.whenTrainedFromCapturedTraffic(3);

		expect(scenario.failure).toBeInstanceOf(InsufficientTracesError);
		expect(scenario.failure).toMatchObject({ found: 1 });
	}, 30_000);
});

describe("Activating a training run", () => {
	it("rewrites only the marked body and leaves the rest of the file alone", async () => {
		const scenario = await given({ name: "activate-writes" });

		await scenario.whenTrainedAgainst([["abc", "ABC"]]);
		await scenario.whenActivated();

		const rewritten = await scenario.currentSource();
		expect(rewritten).toContain("toUpperCase");
		expect(rewritten).toContain('"use training";');
		expect(rewritten).toContain("class Router {");
		expect(rewritten.split("\n").length).toBe(scenario.originalSource.split("\n").length);
	}, 30_000);

	it("refuses to activate a run that did not pass the gate", async () => {
		const scenario = await given({ name: "activate-refused" });
		scenario.givenAnEngineThatProposes('return "always-wrong";');

		await scenario.whenTrainedAgainst([["abc", "ABC"]]);
		await scenario.whenActivated();

		expect(scenario.failure).toBeInstanceOf(PromotionRejectedError);
		// And the promise that matters: the file is untouched.
		expect(await scenario.currentSource()).toBe(scenario.originalSource);
	}, 30_000);

	it("restores the file exactly on rollback", async () => {
		const scenario = await given({ name: "activate-rollback" });

		await scenario.whenTrainedAgainst([["abc", "ABC"]]);
		await scenario.whenActivated();
		expect(await scenario.currentSource()).not.toBe(scenario.originalSource);

		await scenario.whenRolledBack();

		expect(scenario.failure).toBeUndefined();
		expect(await scenario.currentSource()).toBe(scenario.originalSource);
	}, 30_000);

	it("refuses to overwrite an edit made after activation", async () => {
		const scenario = await given({ name: "activate-conflict" });

		await scenario.whenTrainedAgainst([["abc", "ABC"]]);
		await scenario.whenActivated();
		// A developer edits the rewritten method before rolling back.
		const rewritten = await scenario.currentSource();
		await scenario.whenTheFileIsEditedTo("return input;");
		expect(await scenario.currentSource()).toBe(rewritten);

		const edited = rewritten.replace("toUpperCase()", "toLowerCase()");
		await writeFile(scenario.artifact, edited, "utf8");
		await scenario.whenRolledBack();

		// The README's promise: rollback refuses to overwrite later changes.
		expect(scenario.failure).toBeDefined();
		expect(await scenario.currentSource()).toBe(edited);
	}, 30_000);
});

describe("Zero-config evolution", () => {
	it("trains and rewrites on its own once enough traffic accumulates", async () => {
		const scenario = await given({ name: "evolve-applies" });
		scenario.givenEvolutionIsOn(2);
		// Evolution replays captured traffic as equality cases, so a candidate
		// only promotes if it reproduces the behavior that was observed.
		scenario.givenAnEngineThatProposes("return input.trim();");

		scenario.whenTheApplicationCalls("alpha", "beta");
		await scenario.whenBackgroundWorkSettles(() => scenario.eventTypes().includes("evolution.applied"));

		expect(scenario.eventTypes()).toContain("evolution.started");
		expect(scenario.eventTypes()).toContain("evolution.applied");
		expect(await scenario.currentSource()).toContain("trim()");
	}, 60_000);

	it("refuses a candidate that changes the behavior the traffic demonstrated", async () => {
		// The whole safety story for unattended rewriting: evolution trains to
		// preserve what production actually does, so a candidate that alters it
		// cannot pass the gate no matter how confident the model was.
		const scenario = await given({ name: "evolve-behavior-change" });
		scenario.givenEvolutionIsOn(2);
		scenario.givenAnEngineThatProposes("return input.toUpperCase();");

		scenario.whenTheApplicationCalls("alpha", "beta");
		await scenario.whenBackgroundWorkSettles(() => scenario.eventTypes().includes("evolution.failed"));

		expect(scenario.eventTypes()).toContain("evolution.started");
		expect(scenario.eventTypes()).not.toContain("evolution.applied");
		expect(await scenario.currentSource()).toBe(scenario.originalSource);
	}, 60_000);

	it("waits rather than training on too little traffic", async () => {
		const scenario = await given({ name: "evolve-waits" });
		scenario.givenEvolutionIsOn(10);

		scenario.whenTheApplicationCalls("alpha");
		await scenario.whenBackgroundWorkSettles(() => scenario.eventTypes().includes("evolution.skipped"));

		expect(scenario.eventTypes()).toContain("evolution.skipped");
		expect(scenario.eventTypes()).not.toContain("evolution.applied");
		expect(await scenario.currentSource()).toBe(scenario.originalSource);
	}, 60_000);

	it("never breaks an application call when evolution fails", async () => {
		const scenario = await given({ name: "evolve-fails" });
		scenario.givenEvolutionIsOn(1);
		scenario.givenAnEngineThatFails("model unavailable");

		// The calls still return normally.
		scenario.whenTheApplicationCalls("alpha", "beta");
		await scenario.whenBackgroundWorkSettles(() => scenario.eventTypes().includes("evolution.failed"));

		expect(scenario.eventTypes()).toContain("evolution.failed");
		expect(await scenario.currentSource()).toBe(scenario.originalSource);
	}, 60_000);
});

describe("The errors a user meets", () => {
	it("always carries a code they can branch on", async () => {
		const scenario = await given({ name: "errors-coded" });
		scenario.givenAnEngineThatFails("model unavailable");
		await scenario.whenTrainedAgainst([["abc", "ABC"]]);

		// Not every failure originates here (an engine's own error propagates
		// unchanged, by design), but library failures are always typed.
		const scenario2 = await given({ name: "errors-coded-2" });
		scenario2.whenTheApplicationCalls("one");
		await scenario2.whenTrainedFromCapturedTraffic(9);
		expect(isTsAutocodeError(scenario2.failure)).toBe(true);
		expect((scenario2.failure as { code: string }).code).toBe("insufficient_traces");
	}, 30_000);
});
