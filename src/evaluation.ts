import {
	evaluate,
	type EvalConfig,
	type EvalRunResult,
	type EvalTestInput,
} from "@agentv/core";

import type { BoundEvaluation } from "./engine.js";
import type { TrainableToken } from "./token.js";

const metadataKey = "ts-autocode.trainable.id";

export interface TrainableEvalRun {
	readonly token: TrainableToken;
	readonly run: EvalRunResult;
	readonly evaluations: readonly BoundEvaluation[];
}

/** Run AgentV and bind every result to the same trainable token as its region. */
export async function evaluateTrainable(token: TrainableToken, config: EvalConfig): Promise<TrainableEvalRun> {
	const run = await evaluate({
		...config,
		...(config.tests === undefined ? {} : { tests: config.tests.map((test) => bindTest(test, token)) }),
	});
	return Object.freeze({
		token,
		run,
		evaluations: run.results.map((result) => ({ trainableId: token.id, result })),
	});
}

function bindTest(test: EvalTestInput, token: TrainableToken): EvalTestInput {
	return {
		...test,
		metadata: {
			...test.metadata,
			[metadataKey]: token.id,
		},
	};
}
