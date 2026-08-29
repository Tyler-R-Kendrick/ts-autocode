import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	conformanceSuites,
	createHarnessLoop,
	directExecutor,
	MemoryTrainingStore,
	rewritePromotion,
	sequentialLoop,
	type ImplementationExecutor,
	type PromotionApplier,
	type TrainingEngine,
	type TrainingStore,
} from "../src/index.js";
import { executeImplementation } from "../src/execution.js";

// Contract tests: every implementation this repo ships, run against the same
// conformance suite a third party would use.
//
// The provider-neutral design says any structurally compatible implementation
// works. That was only ever checked against these implementations informally,
// through the paths that happened to exercise them -- which is not the same as
// checking they satisfy a stated contract. Running the shipped providers
// through the published suite also proves the suite is satisfiable, which is
// what makes it safe to hand to someone else.

const directory = "test/output/contract";

describe("TrainingStore conformance", () => {
	const stores: ReadonlyArray<readonly [string, () => TrainingStore]> = [
		["MemoryTrainingStore", () => new MemoryTrainingStore()],
		// A second, deliberately different implementation: if the suite only
		// ever sees one shape, it is describing that shape rather than a
		// contract.
		["a minimal third-party store", () => new ArrayStore()],
	];

	for (const [name, factory] of stores) {
		describe(name, () => {
			it.each(conformanceSuites.trainingStore.map((check) => [check.name, check] as const))(
				"%s", async (_label, check) => {
					await check.run(factory);
				},
			);
		});
	}
});

describe("TrainingEngine conformance", () => {
	const engine: TrainingEngine = {
		id: "contract/stub",
		optimize: async (_request, context) => {
			context.signal?.throwIfAborted();
			return { implementation: "return input;" };
		},
	};

	it.each(conformanceSuites.trainingEngine.map((check) => [check.name, check] as const))(
		"%s", async (_label, check) => {
			await check.run(() => engine);
		},
	);
});

describe("ImplementationExecutor conformance", () => {
	const executors: ReadonlyArray<readonly [string, ImplementationExecutor]> = [
		["the Ax sandbox executor", executeImplementation],
		["the shipped direct executor", directExecutor],
	];

	for (const [name, executor] of executors) {
		describe(name, () => {
			it.each(conformanceSuites.implementationExecutor.map((check) => [check.name, check] as const))(
				"%s", async (_label, check) => {
					await check.run(() => executor);
				}, 30_000,
			);
		});
	}
});

describe("TrainingLoop conformance", () => {
	const loops: ReadonlyArray<readonly [string, () => ReturnType<typeof createHarnessLoop>]> = [
		["sequentialLoop", () => sequentialLoop],
		["the governed harness loop", () => createHarnessLoop()],
	];

	for (const [name, factory] of loops) {
		describe(name, () => {
			it.each(conformanceSuites.trainingLoop.map((check) => [check.name, check] as const))(
				"%s", async (_label, check) => {
					await check.run(factory);
				}, 30_000,
			);
		});
	}
});

describe("PromotionApplier conformance", () => {
	// The shipped applier writes to the target's artifactRef, so the fixture has
	// to exist on disk for the approved-candidate check.
	const applier: PromotionApplier = async (candidate, decision, executor) => {
		await mkdir(directory, { recursive: true });
		const artifact = join(directory, "fixture.ts");
		await writeFile(artifact, await readFile("packages/training/src/conformance.ts", "utf8").then(() => fixtureSource), "utf8");
		return rewritePromotion(
			{ ...candidate, target: { ...candidate.target, artifactRef: artifact } },
			decision,
			executor,
		);
	};

	it.each(conformanceSuites.promotionApplier.map((check) => [check.name, check] as const))(
		"%s", async (_label, check) => {
			await check.run(() => applier);
		},
	);
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

const fixtureSource = `class Fixture {
	route(input: string): string {
		"use training";
		return input;
	}
}
`;

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


