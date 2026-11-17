import { Cause, Effect, Exit } from "effect";

import { errorMessage } from "./attempt.js";
import type { WriteAheadAgentBus } from "./bus.js";
import type { AgentBusEntry } from "./schema.js";

export type JudgeDecision = "pass" | "fail";

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

const judgeActor = "judge";
const decisionKind = "agent.decision";
const failureOf = (kind: string) => `${kind}.failed`;
const completionOf = (kind: string) => `${kind}.completed`;

export function recordDecision(
	bus: WriteAheadAgentBus,
	payload: Readonly<{ subject: string; decision: JudgeDecision; [detail: string]: unknown }>,
): Promise<AgentBusEntry> {
	return bus.agent(judgeActor)(decisionKind, payload);
}

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
		yield* promised(() => agent(completionOf(kind), { actionId: action.id, result }));
		return result;
	});
	return runUnwrapped(program);
}

const promised = <A>(fn: () => Promise<A>) => Effect.tryPromise({ try: fn, catch: (error) => error });

async function runUnwrapped<T>(effect: Effect.Effect<T, unknown>): Promise<T> {
	const exit = await Effect.runPromiseExit(effect);
	if (Exit.isSuccess(exit)) return exit.value;
	throw Cause.squash(exit.cause);
}
