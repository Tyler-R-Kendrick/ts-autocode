import { candidateDeclaration, type CandidatePatch, type ImplementationExecutor, type TrainingEngine } from "./engine.js";
import type { TrainingLoop } from "./loop.js";
import type { PromotionApplier } from "./training.js";
import type { TrainableTarget } from "./source.js";
import { discoverInSource } from "./source.js";
import type { TrainingRecord, TrainingStore } from "./records.js";
import { defineTrainable, type TrainableId } from "./token.js";

// Conformance suites for the seams this package injects.
//
// `TrainingEngine`, `ImplementationExecutor`, `TrainingLoop`, `PromotionApplier`
// and `TrainingStore` are the whole point of the provider-neutral design: any
// structurally compatible implementation is supposed to work. That claim was
// only ever checked against the implementations shipped here, which is not a
// claim about anyone else's.
//
// These ship in the package so an implementer can run them against their own
// provider. They are framework-agnostic on purpose, a list of named checks
// that throw on violation, driven by whatever test runner the consumer has:
//
//   import { trainingStoreContract } from "ts-autocode-training";
//
//   for (const check of trainingStoreContract) {
//     it(check.name, () => check.run(() => new MyStore()));
//   }

/** One conformance check. `run` resolves when the subject conforms and rejects
 * with a message naming the violated rule when it does not. */
export interface ConformanceCheck<TSubject> {
	readonly name: string;
	run(subject: TSubject): Promise<void>;
}

/** A factory, because most checks need a fresh, empty subject. */
export type Factory<T> = () => T | Promise<T>;

class ConformanceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConformanceError";
	}
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new ConformanceError(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
	assert(
		JSON.stringify(actual) === JSON.stringify(expected),
		`${message} (expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)})`,
	);
}

function check<T>(name: string, run: (subject: T) => Promise<void>): ConformanceCheck<T> {
	return { name, run };
}


const fixtureSource = `class Fixture {
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

/** A discovered target implementers can run checks against. */
export const conformanceTarget: TrainableTarget = discoverInSource(fixtureSource, "conformance.ts")[0]!;

/** An async discovered target, for executors that distinguish them. */
export const conformanceAsyncTarget: TrainableTarget = discoverInSource(fixtureSource, "conformance.ts")[1]!;

function record(trainableId: TrainableId, id: string, succeeded = true): TrainingRecord {
	return {
		id,
		runId: `run-${id}`,
		trainableId,
		method: "route",
		succeeded,
		recordedAt: new Date(0).toISOString(),
		trace: { messages: [] } as unknown as TrainingRecord["trace"],
	};
}

/** A candidate bound to {@link conformanceTarget}. */
export function conformanceCandidate(implementation = "return input;"): CandidatePatch {
	return {
		id: "conformance-candidate",
		trainableId: conformanceTarget.id,
		engineId: "conformance",
		target: conformanceTarget,
		implementation,
	};
}


/** What every {@link TrainingStore} must do. Captures are appended off the hot
 * path and read back to build eval cases, so ordering, filtering and isolation
 * are the properties the runtime actually depends on. */
export const trainingStoreContract: readonly ConformanceCheck<Factory<TrainingStore>>[] = [
	check("starts empty", async (factory) => {
		assertEqual((await (await factory()).list()).length, 0, "a fresh store must list nothing");
	}),

	check("lists what it appended", async (factory) => {
		const store = await factory();
		const token = defineTrainable("Conformance.one");
		await store.append(record(token.id, "a"));
		const listed = await store.list();
		assertEqual(listed.length, 1, "one appended record must be listed");
		assertEqual(listed[0]?.id, "a", "the listed record must be the appended one");
	}),

	check("preserves append order", async (factory) => {
		const store = await factory();
		const token = defineTrainable("Conformance.order");
		for (const id of ["a", "b", "c"]) await store.append(record(token.id, id));
		assertEqual((await store.list()).map((entry) => entry.id), ["a", "b", "c"],
			"records must be listed in the order they were appended");
	}),

	check("filters by trainable id", async (factory) => {
		const store = await factory();
		const first = defineTrainable("Conformance.first");
		const second = defineTrainable("Conformance.second");
		await store.append(record(first.id, "a"));
		await store.append(record(second.id, "b"));
		assertEqual((await store.list(first.id)).map((entry) => entry.id), ["a"],
			"listing by id must return only that trainable's records");
		assertEqual((await store.list()).length, 2, "listing without an id must return every record");
	}),

	check("returns an empty list for an unknown id rather than throwing", async (factory) => {
		const store = await factory();
		assertEqual((await store.list(defineTrainable("Conformance.absent").id)).length, 0,
			"an unknown trainable id must list nothing");
	}),

	check("does not alias caller state", async (factory) => {
		// The runtime reads records repeatedly while training; a store handing
		// back live references lets one caller corrupt another's view.
		const store = await factory();
		const token = defineTrainable("Conformance.alias");
		const appended = record(token.id, "a");
		await store.append(appended);
		const first = await store.list();
		(first as TrainingRecord[])[0] = record(token.id, "mutated");
		assertEqual((await store.list()).map((entry) => entry.id), ["a"],
			"mutating a returned list must not change what the store holds");
	}),

	check("tolerates concurrent appends", async (factory) => {
		const store = await factory();
		const token = defineTrainable("Conformance.concurrent");
		await Promise.all(["a", "b", "c", "d"].map((id) => store.append(record(token.id, id))));
		assertEqual((await store.list()).length, 4, "every concurrently appended record must survive");
	}),

	check("keeps failed records, which replay must exclude rather than lose", async (factory) => {
		const store = await factory();
		const token = defineTrainable("Conformance.failed");
		await store.append(record(token.id, "ok", true));
		await store.append(record(token.id, "bad", false));
		const listed = await store.list(token.id);
		assertEqual(listed.length, 2, "a store must keep failed records too");
		assertEqual(listed.filter((entry) => entry.succeeded).length, 1, "succeeded must survive the round trip");
	}),
];


/** What every {@link TrainingEngine} must do. The runtime composes a strategy
 * into its own validating pipeline, so an engine's obligations are narrow --
 * but they are obligations, and violating them fails late and confusingly. */
export const trainingEngineContract: readonly ConformanceCheck<Factory<TrainingEngine>>[] = [
	check("has a non-empty id", async (factory) => {
		const engine = await factory();
		assert(typeof engine.id === "string" && engine.id.trim().length > 0,
			"an engine must have a non-empty string id, which names it in candidate provenance");
	}),

	check("returns an implementation for a well-formed request", async (factory) => {
		const engine = await factory();
		const candidate = await engine.optimize({
			trainableId: conformanceTarget.id,
			objective: "Preserve behavior",
			target: conformanceTarget,
			records: [],
			evaluations: [],
		}, { variables: {} });
		assert(typeof candidate.implementation === "string",
			"optimize must resolve an object whose `implementation` is a string");
		assert(candidate.implementation.trim().length > 0,
			"optimize must not resolve an empty implementation");
	}),

	check("does not mutate the request it is given", async (factory) => {
		const engine = await factory();
		const request = {
			trainableId: conformanceTarget.id,
			objective: "Preserve behavior",
			target: conformanceTarget,
			records: [],
			evaluations: [],
		};
		const before = JSON.stringify(request);
		await engine.optimize(request, { variables: {} });
		assertEqual(JSON.stringify(request), before, "optimize must treat its request as read-only");
	}),

	check("honors an already-aborted signal", async (factory) => {
		const engine = await factory();
		const controller = new AbortController();
		controller.abort();
		let settled = "resolved";
		try {
			await engine.optimize({
				trainableId: conformanceTarget.id,
				objective: "Preserve behavior",
				target: conformanceTarget,
				records: [],
				evaluations: [],
			}, { variables: {}, signal: controller.signal });
		} catch {
			settled = "rejected";
		}
		assert(settled === "rejected", "optimize must reject when given an already-aborted signal");
	}),
];


/** What every {@link ImplementationExecutor} must do. Candidate verification
 * runs entirely through this seam, so a divergence here silently changes what
 * the promotion gate is deciding about. */
export const implementationExecutorContract: readonly ConformanceCheck<Factory<ImplementationExecutor>>[] = [
	check("runs a body and returns its value", async (factory) => {
		const execute = await factory();
		assertEqual(await execute(conformanceTarget, "return input;", ["hello"]), "hello",
			"an executor must return what the candidate body returns");
	}),

	check("passes arguments positionally", async (factory) => {
		const execute = await factory();
		assertEqual(await execute(conformanceTarget, "return input.toUpperCase();", ["abc"]), "ABC",
			"the first argument must bind to the target's first parameter");
	}),

	check("surfaces a throwing body as a rejection", async (factory) => {
		const execute = await factory();
		let rejected = false;
		try {
			await execute(conformanceTarget, 'throw new Error("boom");', ["x"]);
		} catch {
			rejected = true;
		}
		assert(rejected, "a body that throws must reject rather than resolve");
	}),

	check("resolves a promise the body returns", async (factory) => {
		const execute = await factory();
		assertEqual(await execute(conformanceAsyncTarget, "return input;", ["hello"]), "hello",
			"an async target's result must be awaited, not returned as a promise");
	}),

	check("declares the target the same way the engine validated it", async () => {
		// Both sides must agree on the synthetic wrapper or an executor runs
		// something the engine never typechecked.
		const declaration = candidateDeclaration(conformanceTarget, "return input;");
		assert(declaration.includes("function candidate("),
			"candidateDeclaration must wrap the body in a `candidate` function");
		assert(declaration.includes(conformanceTarget.returnType),
			"the declaration must carry the target's return type");
	}),
];


/** What every {@link TrainingLoop} must do. The loop owns iteration and
 * stopping; proposing and reviewing stay with the runtime, and the runtime
 * reads `rounds` to decide what to activate. */
export const trainingLoopContract: readonly ConformanceCheck<Factory<TrainingLoop>>[] = [
	check("calls propose and review, and reports the rounds it ran", async (factory) => {
		const loop = await factory();
		let proposed = 0;
		let reviewed = 0;
		const result = await loop({
			trainableId: conformanceTarget.id,
			objective: "Preserve behavior",
			rubric: "Must pass",
			outputDir: "test/output/conformance",
			maxRounds: 1,
			propose: async () => {
				proposed += 1;
				return conformanceCandidate();
			},
			review: async (candidate) => {
				reviewed += 1;
				return {
					verification: { token: defineTrainable(candidate.trainableId), run: emptyRun(), evaluations: [] },
					decision: { candidateId: candidate.id, promote: true, failures: [], meanScore: 1, passRate: 1 },
				};
			},
		});
		assert(proposed > 0, "a loop must call propose at least once");
		assert(reviewed > 0, "a loop must review what it proposed");
		assert(result.rounds.length > 0, "a loop that reviewed a candidate must report it in rounds");
	}),

	check("reports `ready` when a candidate is promotable", async (factory) => {
		const loop = await factory();
		const result = await loop(promotingInput(await Promise.resolve(true)));
		assertEqual(result.outcome, "ready", "a promotable candidate must produce the `ready` outcome");
	}),

	check("does not report `ready` when nothing is promotable", async (factory) => {
		const loop = await factory();
		const result = await loop(promotingInput(false));
		assert(result.outcome !== "ready",
			"a loop must not report `ready` when every review refused the candidate");
	}),

	check("returns the winning round last", async (factory) => {
		// The runtime activates `rounds.at(-1)`, so a loop that emits the winner
		// anywhere else silently activates the wrong candidate.
		const loop = await factory();
		const result = await loop(promotingInput(true));
		const final = result.rounds.at(-1);
		if (result.outcome === "ready") {
			assert(final?.decision.promote === true,
				"when the outcome is `ready`, the last round must be the promotable one");
		}
	}),

	check("respects maxRounds", async (factory) => {
		const loop = await factory();
		let proposed = 0;
		const result = await loop({
			...promotingInput(false),
			maxRounds: 2,
			propose: async () => {
				proposed += 1;
				return { ...conformanceCandidate(), id: `candidate-${proposed}` };
			},
		});
		assert(proposed <= 2, `a loop must not propose more than maxRounds times (proposed ${proposed})`);
		assert(result.rounds.length <= 2, "a loop must not report more rounds than maxRounds");
	}),

	check("stops proposing once its signal is aborted", async (factory) => {
		// Rejecting or returning early are both acceptable; continuing to
		// propose after an abort is not, because each proposal is an engine
		// call the caller has already said to stop paying for.
		const loop = await factory();
		const controller = new AbortController();
		const budget = 20;
		let proposed = 0;
		try {
			await loop({
				...promotingInput(false),
				maxRounds: budget,
				signal: controller.signal,
				propose: async () => {
					proposed += 1;
					controller.abort();
					return { ...conformanceCandidate(), id: `candidate-${proposed}` };
				},
			});
		} catch {
			// An aborted loop may reject; that is one of the acceptable shapes.
		}
		assert(proposed < budget,
			`a loop must stop proposing after its signal aborts (proposed ${proposed} of ${budget})`);
	}),
];

function emptyRun() {
	return {
		results: [],
		summary: { total: 0, passed: 0, failed: 0, executionErrors: 0, durationMs: 0, meanScore: 0 },
	} as never;
}

function promotingInput(promote: boolean) {
	return {
		trainableId: conformanceTarget.id,
		objective: "Preserve behavior",
		rubric: "Must pass",
		outputDir: "test/output/conformance",
		maxRounds: 1,
		propose: async () => conformanceCandidate(),
		review: async (candidate: CandidatePatch) => ({
			verification: { token: defineTrainable(candidate.trainableId), run: emptyRun(), evaluations: [] },
			decision: {
				candidateId: candidate.id,
				promote,
				failures: promote ? [] : ["conformance refusal"],
				meanScore: promote ? 1 : 0,
				passRate: promote ? 1 : 0,
			},
		}),
	};
}


/** What every {@link PromotionApplier} must do. Training requires only that an
 * application be undoable, but it requires that absolutely, because it is the
 * only thing standing between a bad candidate and a permanently edited file. */
export const promoterContract: readonly ConformanceCheck<Factory<PromotionApplier>>[] = [
	check("refuses a candidate the gate did not pass", async (factory) => {
		const promote = await factory();
		let rejected = false;
		try {
			const applied = await promote(conformanceCandidate(), {
				candidateId: "conformance-candidate", promote: false, failures: ["refused"], meanScore: 0, passRate: 0,
			});
			await applied.rollback();
		} catch {
			rejected = true;
		}
		assert(rejected, "an applier must refuse a decision whose `promote` is false");
	}),

	check("refuses a decision naming a different candidate", async (factory) => {
		const promote = await factory();
		let rejected = false;
		try {
			const applied = await promote(conformanceCandidate(), {
				candidateId: "some-other-candidate", promote: true, failures: [], meanScore: 1, passRate: 1,
			});
			await applied.rollback();
		} catch {
			rejected = true;
		}
		assert(rejected, "an applier must refuse a decision bound to a different candidate");
	}),

	check("returns an undo for an approved candidate", async (factory) => {
		const promote = await factory();
		const applied = await promote(conformanceCandidate(), {
			candidateId: "conformance-candidate", promote: true, failures: [], meanScore: 1, passRate: 1,
		});
		assert(typeof applied.rollback === "function",
			"an applier must return an object with a `rollback` function");
		await applied.rollback();
	}),
];

/** Every suite, for an implementer who wants to run the lot. */
/** @deprecated Renamed to {@link promoterContract}, matching the `Promoter`
 * seam name. The same checks, verbatim. */
export const promotionApplierContract = promoterContract;

export const conformanceSuites = Object.freeze({
	trainingStore: trainingStoreContract,
	trainingEngine: trainingEngineContract,
	implementationExecutor: implementationExecutorContract,
	trainingLoop: trainingLoopContract,
	promotionApplier: promoterContract,
});
