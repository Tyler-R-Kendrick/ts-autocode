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
 * the action is logged and executed. */
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
	if (gate) {
		let decision: JudgeDecision;
		try {
			decision = await gate(action, await bus.read());
		} catch (error) {
			// The gate error is the outcome; a failing failure record must not replace it.
			await agent(failureOf(kind), { actionId: action.id, stage: "gate", message: errorMessage(error) })
				.catch(() => undefined);
			throw error;
		}
		await recordDecision(bus, { subject: "action", actionId: action.id, decision });
		if (decision === "fail") throw new AgentActionDeniedError(action);
	}
	let result: T;
	try {
		result = await execute();
	} catch (error) {
		// Likewise: the execution error is the outcome, recorded best-effort.
		await agent(failureOf(kind), { actionId: action.id, message: errorMessage(error) })
			.catch(() => undefined);
		throw error;
	}
	// Recorded after the fact, outside the catch: a failing completion append
	// surfaces as a bus error, never as a failed action.
	await agent(completionOf(kind), { actionId: action.id, result });
	return result;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
