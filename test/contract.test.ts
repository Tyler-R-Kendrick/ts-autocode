import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, it } from "vitest";

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


const directory = "test/output/contract";

describe("TrainingStore conformance", () => {
	const stores: ReadonlyArray<readonly [string, () => TrainingStore]> = [
		["MemoryTrainingStore", () => new MemoryTrainingStore()],
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
	const applier: PromotionApplier = async (candidate, decision, executor) => {
		await mkdir(directory, { recursive: true });
		const artifact = join(directory, "fixture.ts");
		await writeFile(artifact, fixtureSource, "utf8");
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

const fixtureSource = `class Fixture {
	route(input: string): string {
		"use training";
		return input;
	}
}
`;

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


