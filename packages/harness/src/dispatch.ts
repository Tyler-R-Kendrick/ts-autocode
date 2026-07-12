import type { AgentBusEntry, WriteAheadAgentBus } from "./bus.js";

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

/** The message kind the gate's verdicts are recorded under. */
export const decisionKind = "agent.decision";

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
	const action = await bus.append({ actor, kind, ...(payload === undefined ? {} : { payload }) });
	if (gate) {
		let decision: JudgeDecision;
		try {
			decision = requireDecision(await gate(action, await bus.read()));
		} catch (error) {
			// The gate error is the outcome; a failing failure record must not replace it.
			await bus.append({
				actor,
				kind: `${kind}.failed`,
				payload: { actionId: action.id, stage: "gate", message: errorMessage(error) },
			}).catch(() => undefined);
			throw error;
		}
		await bus.append({ actor: "judge", kind: decisionKind, payload: { subject: "action", actionId: action.id, decision } });
		if (decision === "fail") throw new AgentActionDeniedError(action);
	}
	let result: T;
	try {
		result = await execute();
	} catch (error) {
		// Likewise: the execution error is the outcome, recorded best-effort.
		await bus.append({ actor, kind: `${kind}.failed`, payload: { actionId: action.id, message: errorMessage(error) } })
			.catch(() => undefined);
		throw error;
	}
	// Recorded after the fact, outside the catch: a failing completion append
	// surfaces as a bus error, never as a failed action.
	await bus.append({ actor, kind: `${kind}.completed`, payload: { actionId: action.id, result } });
	return result;
}

export function requireDecision(value: unknown): JudgeDecision {
	if (value !== "pass" && value !== "fail") throw new Error("judge must return exactly pass or fail");
	return value;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
