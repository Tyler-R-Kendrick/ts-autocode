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

/** Run AgentV and bind every result to the same trainable method. */
export async function evaluateTrainable(token: TrainableToken, config: EvalConfig): Promise<TrainableEvalRun> {
	const tests = config.tests?.map((test) => bindTest(test, token));
	const run = await evaluate({
		...config,
		...(tests === undefined ? {} : { tests }),
	});
	const testsById = new Map(tests?.map((test) => [test.id, test]));
	return Object.freeze({
		token,
		run,
		evaluations: run.results.map((result) => {
			const test = testsById.get(result.testId);
			return { trainableId: token.id, result, ...(test === undefined ? {} : { test }) };
		}),
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
