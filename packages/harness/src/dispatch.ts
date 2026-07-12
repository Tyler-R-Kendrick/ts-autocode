import { Cause, Effect, Exit } from "effect";

import { errorMessage } from "./attempt.js";
import type { WriteAheadAgentBus } from "./bus.js";
import type { AgentBusEntry } from "./schema.js";

/** The only verdicts a judge may return. Gates and judges are typed against
 * this union, so their outputs are used as returned — nothing re-parses them. */
export type JudgeDecision = "pass" | "fail";

/** Decides whether a proposed action may execute. In this harness the gate is
 * implemented by the judge — an ordinary actor whose verdict is recorded on
 * the bus as one more message, with no special standing there. */
export type ActionGate = (
	action: AgentBusEntry,
	context: readonly AgentBusEntry[],
) => JudgeDecision | Promise<JudgeDecision>;

export class AgentActionDeniedError extends Error {
	readonly _tag = "AgentActionDenied" as const;
	readonly action: AgentBusEntry;

	constructor(action: AgentBusEntry) {
		super(`gate denied ${action.actor} action: ${action.kind}`);
		this.name = "AgentActionDeniedError";
		this.action = action;
	}
}

// The names the write-ahead convention itself writes, spelled once here. Bus
// entries are serialized to storage, so these must stay plain strings —
// symbols would not survive the round trip.
const judgeActor = "judge";
const decisionKind = "agent.decision";
const failureOf = (kind: string) => `${kind}.failed`;
const completionOf = (kind: string) => `${kind}.completed`;

/** Records a verdict on the bus as the judge's own message. */
export function recordDecision(
	bus: WriteAheadAgentBus,
	payload: Readonly<{ subject: string; decision: JudgeDecision; [detail: string]: unknown }>,
): Promise<AgentBusEntry> {
	return bus.agent(judgeActor)(decisionKind, payload);
}

/** The write-ahead convention, layered on top of the plain message bus:
 * record the intent, ask the gate, record the verdict as the judge's own
 * message, execute only after a pass, and record the outcome. Without a gate
 * the action is logged and executed. Failure records are best-effort taps —
 * the gate or execution error stays the outcome, rethrown as itself. */
export async function dispatchAction<T>(
	bus: WriteAheadAgentBus,
	actor: string,
	kind: string,
	payload: unknown,
	gate: ActionGate | undefined,
	execute: () => Promise<T> | T,
): Promise<T> {
	const agent = bus.agent(actor);
	const action = await agent(kind, payload);
	const recordFailure = (error: unknown, detail: Readonly<Record<string, unknown>>) =>
		Effect.ignore(promised(() => agent(failureOf(kind), { actionId: action.id, ...detail, message: errorMessage(error) })));
	const program = Effect.gen(function* () {
		if (gate) {
			const decision = yield* promised(async () => gate(action, await bus.read())).pipe(
				Effect.tapError((error) => recordFailure(error, { stage: "gate" })),
			);
			yield* promised(() => recordDecision(bus, { subject: "action", actionId: action.id, decision }));
			if (decision === "fail") return yield* Effect.fail(new AgentActionDeniedError(action));
		}
		const result = yield* promised(async () => execute()).pipe(
			Effect.tapError((error) => recordFailure(error, {})),
		);
		// Recorded outside the failure tap: a failing completion append surfaces
		// as a bus error, never as a failed action.
		yield* promised(() => agent(completionOf(kind), { actionId: action.id, result }));
		return result;
	});
	return runUnwrapped(program);
}

const promised = <A>(fn: () => Promise<A>) => Effect.tryPromise({ try: fn, catch: (error) => error });

/** Settles the pipeline into promise semantics, rejecting with the original
 * error rather than Effect's fiber wrapper. */
async function runUnwrapped<T>(effect: Effect.Effect<T, unknown>): Promise<T> {
	const exit = await Effect.runPromiseExit(effect);
	if (Exit.isSuccess(exit)) return exit.value;
	throw Cause.squash(exit.cause);
}
