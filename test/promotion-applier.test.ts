import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	discoverTrainables,
	PromotionRejectedError,
	restoreImplementation,
	rewritePromotion,
	swappedImplementation,
	type CandidatePatch,
	type ImplementationExecutor,
	type PromotionDecision,
	type TrainableTarget,
} from "../src/index.js";

// The shipped promotion applier, on its own.
//
// `rewritePromotion` does two things at once: it writes the guarded source
// rewrite and, for an async target, it hot-swaps the live implementation
// so a long-running process picks the candidate up without a restart. The
// second half had no test at all. It is the half that changes the behavior of
// an application that is already serving traffic, and the half a rollback has
// to undo as exactly as it undoes the file.
//
// The conformance suite (test/contract.test.ts) checks the applier's refusals;
// these check what it does when it accepts.

const directory = "test/output/promotion-applier";

const source = `class Fixture {
	route(input: string): string {
		"use training";
		return input;
	}

	async slow(input: string): Promise<string> {
		"use training";
		return input;
	}
}
`;

let targets: readonly TrainableTarget[];
let artifact: string;

beforeEach(async () => {
	await rm(directory, { recursive: true, force: true });
	await mkdir(directory, { recursive: true });
	artifact = join(directory, "fixture.ts");
	await writeFile(artifact, source, "utf8");
	targets = discoverTrainables({ files: [artifact] });
});

// The swap registry is module-global and keyed by trainable id, so a test that
// installs one and never rolls back leaves it for the next test in the file --
// which makes "does not swap" assertions pass or fail on declaration order.
afterEach(() => {
	for (const entry of targets) restoreImplementation(entry.id);
});

function target(methodName: string): TrainableTarget {
	const found = targets.find((entry) => entry.methodName === methodName);
	if (!found) throw new Error(`no discovered target named ${methodName}`);
	return found;
}

function candidateFor(methodName: string, implementation: string): CandidatePatch {
	return {
		id: `candidate-${methodName}`,
		trainableId: target(methodName).id,
		engineId: "test",
		target: target(methodName),
		implementation,
	};
}

function approving(candidate: CandidatePatch): PromotionDecision {
	return { candidateId: candidate.id, promote: true, failures: [], meanScore: 1, passRate: 1 };
}

/** Records what the applier hands the executor when a swapped call runs. */
function recordingExecutor(): ImplementationExecutor & { calls: unknown[][] } {
	const calls: unknown[][] = [];
	const executor = (async (executed, implementation, args, options) => {
		calls.push([executed.id, implementation, args, options?.receiver]);
		return `executed:${String(args[0])}`;
	}) as ImplementationExecutor & { calls: unknown[][] };
	executor.calls = calls;
	return executor;
}

describe("the shipped promotion applier", () => {
	it("writes the candidate into the file it was discovered from", async () => {
		const candidate = candidateFor("route", "return input.toUpperCase();");
		await rewritePromotion(candidate, approving(candidate));

		const written = await readFile(artifact, "utf8");
		expect(written).toContain("return input.toUpperCase();");
		expect(written).toContain('"use training";');
		// The sibling method is untouched.
		expect(written).toContain("async slow(input: string): Promise<string> {");
	});

	it("restores the file byte-for-byte on rollback", async () => {
		const candidate = candidateFor("route", "return input.toUpperCase();");
		const applied = await rewritePromotion(candidate, approving(candidate));
		await applied.rollback();
		expect(await readFile(artifact, "utf8")).toBe(source);
	});

	describe("hot-swapping an async target", () => {
		it("installs a live implementation so a running process picks it up", async () => {
			const candidate = candidateFor("slow", "return input.toUpperCase();");
			const executor = recordingExecutor();
			await rewritePromotion(candidate, approving(candidate), executor);

			const swapped = swappedImplementation(candidate.trainableId);
			expect(swapped).toBeTypeOf("function");
		});

		it("routes a swapped call through the executor, forwarding arguments and the receiver", async () => {
			const candidate = candidateFor("slow", "return input.toUpperCase();");
			const executor = recordingExecutor();
			await rewritePromotion(candidate, approving(candidate), executor);

			const receiver = { name: "the live instance" };
			const swapped = swappedImplementation(candidate.trainableId);
			expect(await swapped?.call(receiver, "abc")).toBe("executed:abc");
			expect(executor.calls).toEqual([[
				candidate.target.id,
				"return input.toUpperCase();",
				["abc"],
				receiver,
			]]);
		});

		it("removes the live implementation on rollback, along with the file edit", async () => {
			const candidate = candidateFor("slow", "return input.toUpperCase();");
			const applied = await rewritePromotion(candidate, approving(candidate), recordingExecutor());
			expect(swappedImplementation(candidate.trainableId)).toBeDefined();

			await applied.rollback();
			expect(swappedImplementation(candidate.trainableId)).toBeUndefined();
			expect(await readFile(artifact, "utf8")).toBe(source);
		});
	});

	describe("leaving a synchronous target alone", () => {
		it("does not swap a sync method, whose calling convention the executor would change", async () => {
			// The executor returns a promise. Swapping it in for a method declared
			// `(input: string): string` would hand every caller a promise where
			// they typed a string, so only async targets swap.
			const candidate = candidateFor("route", "return input.toUpperCase();");
			await rewritePromotion(candidate, approving(candidate), recordingExecutor());
			expect(swappedImplementation(candidate.trainableId)).toBeUndefined();
		});

		it("does not swap an async target when no executor was supplied", async () => {
			const candidate = candidateFor("slow", "return input.toUpperCase();");
			await rewritePromotion(candidate, approving(candidate));
			expect(swappedImplementation(candidate.trainableId)).toBeUndefined();
		});
	});

	describe("refusing to apply", () => {
		it.each([
			["the gate refused", (candidate: CandidatePatch) => ({ ...approving(candidate), promote: false })],
			["the decision names another candidate", () => ({
				candidateId: "someone-else", promote: true, failures: [], meanScore: 1, passRate: 1,
			})],
		])("throws PromotionRejectedError and leaves the file alone when %s", async (_label, decide) => {
			const candidate = candidateFor("route", "return input.toUpperCase();");
			await expect(rewritePromotion(candidate, decide(candidate) as PromotionDecision))
				.rejects.toBeInstanceOf(PromotionRejectedError);
			expect(await readFile(artifact, "utf8")).toBe(source);
			expect(swappedImplementation(candidate.trainableId)).toBeUndefined();
		});
	});
});
