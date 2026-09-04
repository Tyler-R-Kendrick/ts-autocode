import { describe, expect, it } from "vitest";

import {
	conformanceAsyncTarget,
	conformanceCandidate,
	conformanceSuites,
	conformanceTarget,
} from "../src/conformance.js";
import { directExecutor } from "../src/engine.js";
import { sequentialLoop } from "../src/loop.js";
import type { ImplementationExecutor } from "../src/engine.js";
import type { TrainingStore } from "../src/records.js";

// The conformance kit's own tests. A suite that passes for everything is not a
// contract, so each check is run against an implementation that violates
// exactly the rule it names.
//
// These import from `../src/`, unlike test/contract.test.ts at the root, which
// exercises the shipped providers through the built package. Both matter: this
// one says the kit is correct, that one says the providers satisfy it.

describe("the conformance suite itself", () => {
	// A suite that passes for everything is not a contract. These prove each
	// suite rejects an implementation that violates the rule it names.
	it("rejects a store that loses append order", async () => {
		const failures = await failing(conformanceSuites.trainingStore, () => new ReversingStore());
		expect(failures).toContain("preserves append order");
	});

	it("rejects a store that aliases its internal state", async () => {
		const failures = await failing(conformanceSuites.trainingStore, () => new AliasingStore());
		expect(failures).toContain("does not alias caller state");
	});

	it("rejects a store that ignores the trainable id filter", async () => {
		const failures = await failing(conformanceSuites.trainingStore, () => new UnfilteredStore());
		expect(failures).toContain("filters by trainable id");
	});

	it("rejects an engine with a blank id", async () => {
		const failures = await failing(conformanceSuites.trainingEngine,
			() => ({ id: "  ", optimize: async () => ({ implementation: "return input;" }) }));
		expect(failures).toContain("has a non-empty id");
	});

	it("rejects an engine that returns nothing usable", async () => {
		const failures = await failing(conformanceSuites.trainingEngine,
			() => ({ id: "empty", optimize: async () => ({ implementation: "   " }) }));
		expect(failures).toContain("returns an implementation for a well-formed request");
	});

	it("rejects an engine that ignores an aborted signal", async () => {
		const failures = await failing(conformanceSuites.trainingEngine,
			() => ({ id: "deaf", optimize: async () => ({ implementation: "return input;" }) }));
		expect(failures).toContain("honors an already-aborted signal");
	});

	it("rejects an executor that swallows a throwing body", async () => {
		const failures = await failing(conformanceSuites.implementationExecutor,
			() => (async () => "swallowed") as ImplementationExecutor);
		expect(failures).toContain("surfaces a throwing body as a rejection");
	});

	it("rejects a loop that never reviews", async () => {
		const failures = await failing(conformanceSuites.trainingLoop,
			() => async () => ({ outcome: "exhausted" as const, rounds: [] }));
		expect(failures).toContain("calls propose and review, and reports the rounds it ran");
	});

	it("rejects an applier that promotes a refused candidate", async () => {
		const failures = await failing(conformanceSuites.promotionApplier,
			() => async () => ({ rollback: async () => undefined }));
		expect(failures).toContain("refuses a candidate the gate did not pass");
		expect(failures).toContain("refuses a decision naming a different candidate");
	});

	it("names the violated rule in its message", async () => {
		const check = conformanceSuites.trainingStore.find((entry) => entry.name === "preserves append order");
		await expect(check?.run(() => new ReversingStore()))
			.rejects.toThrow(/must be listed in the order they were appended/);
	});
});


describe("the abort check specifically", () => {
	// This check was written vacuously at first -- it asserted
	// `rejected || resolved`, which is always true. It now counts proposals, so
	// it must reject a loop that ignores the signal.
	it("rejects a loop that keeps proposing after an abort", async () => {
		const deaf = async (input: Parameters<typeof sequentialLoop>[0]) => {
			for (let round = 1; round <= (input.maxRounds ?? 1); round += 1) {
				await input.propose({ round, slot: 1, feedback: [] });
			}
			return { outcome: "exhausted" as const, rounds: [] };
		};
		const failures = await failing(conformanceSuites.trainingLoop, () => deaf);
		expect(failures).toContain("stops proposing once its signal is aborted");
	});

	it("accepts the loop this package ships", async () => {
		for (const loop of [sequentialLoop]) {
			expect(await failing(conformanceSuites.trainingLoop, () => loop)).toEqual([]);
		}
	}, 30_000);
});

/** Names of the checks a subject fails. */
async function failing<T>(
	suite: ReadonlyArray<{ readonly name: string; run(subject: T): Promise<void> }>,
	factory: T,
): Promise<readonly string[]> {
	const names: string[] = [];
	for (const check of suite) {
		try {
			await check.run(factory);
		} catch {
			names.push(check.name);
		}
	}
	return names;
}

/** A store that is not MemoryTrainingStore, to keep the suite honest. */
class ArrayStore implements TrainingStore {
	private readonly entries: string[] = [];
	async append(record: Parameters<TrainingStore["append"]>[0]): Promise<void> {
		this.entries.push(JSON.stringify(record));
	}
	async list(trainableId?: Parameters<TrainingStore["list"]>[0]): Promise<readonly Parameters<TrainingStore["append"]>[0][]> {
		const parsed = this.entries.map((entry) => JSON.parse(entry) as Parameters<TrainingStore["append"]>[0]);
		return trainableId === undefined ? parsed : parsed.filter((entry) => entry.trainableId === trainableId);
	}
}

class ReversingStore extends ArrayStore {
	override async list(trainableId?: Parameters<TrainingStore["list"]>[0]) {
		return [...await super.list(trainableId)].reverse();
	}
}

class AliasingStore implements TrainingStore {
	private readonly records: Parameters<TrainingStore["append"]>[0][] = [];
	async append(record: Parameters<TrainingStore["append"]>[0]): Promise<void> {
		this.records.push(record);
	}
	async list(trainableId?: Parameters<TrainingStore["list"]>[0]) {
		// Hands back the live array: one caller's mutation corrupts every other.
		return trainableId === undefined ? this.records : this.records.filter((entry) => entry.trainableId === trainableId);
	}
}

class UnfilteredStore extends ArrayStore {
	override async list() {
		return super.list();
	}
}

describe("the fixtures the kit publishes", () => {
	// `conformanceTarget`, `conformanceAsyncTarget` and `conformanceCandidate`
	// are exported so an implementer can build their own tests on them, which
	// makes a silent change here a break in suites this repo cannot see.
	//
	// A stale copy of the fixture source used to sit at the bottom of this file
	// under a comment saying it kept the two tied together. Nothing referenced
	// it, so nothing did -- and it had already drifted, describing one method
	// where the kit publishes two.

	it("describes the synchronous fixture method", () => {
		expect(conformanceTarget).toMatchObject({
			id: "Fixture.route",
			methodName: "route",
			className: "Fixture",
			signature: "route(input: string): string",
			returnType: "string",
			async: false,
		});
		expect(conformanceTarget.parameters.map((parameter) => parameter.name)).toEqual(["input"]);
		expect(conformanceTarget.implementation).toBe("return input;");
	});

	it("describes the asynchronous fixture method, which executors distinguish", () => {
		expect(conformanceAsyncTarget).toMatchObject({
			id: "Fixture.slow",
			methodName: "slow",
			async: true,
		});
		expect(conformanceAsyncTarget.id).not.toBe(conformanceTarget.id);
	});

	it("binds the default candidate to the synchronous target", () => {
		const candidate = conformanceCandidate();
		expect(candidate.trainableId).toBe(conformanceTarget.id);
		expect(candidate.target).toBe(conformanceTarget);
		expect(candidate.implementation).toBe("return input;");
	});

	it("takes an implementation for a check that needs a different body", () => {
		expect(conformanceCandidate("return input.trim();").implementation).toBe("return input.trim();");
	});

	it("publishes a body the shipped executor can actually run", async () => {
		// Every executor check runs this pairing, so a target and default body
		// that do not fit together would fail every implementer's suite at once.
		await expect(directExecutor(conformanceTarget, conformanceCandidate().implementation, ["hello"]))
			.resolves.toBe("hello");
		await expect(directExecutor(conformanceAsyncTarget, "return input;", ["hello"])).resolves.toBe("hello");
	});
});
