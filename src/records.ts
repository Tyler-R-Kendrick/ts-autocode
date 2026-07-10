import type { Trace } from "@agentv/core";

import type { TrainableId } from "./token.js";

/** One captured invocation of a trainable method. AgentV owns the trace shape. */
export interface TrainingRecord {
	readonly id: string;
	readonly runId: string;
	readonly trainableId: TrainableId;
	readonly method: string;
	readonly trace: Trace;
	readonly succeeded: boolean;
	readonly recordedAt: string;
}

export interface TrainingStore {
	append(record: TrainingRecord): Promise<void>;
	list(trainableId?: TrainableId): Promise<readonly TrainingRecord[]>;
}

export function createMemoryTrainingStore(): TrainingStore {
	const records: TrainingRecord[] = [];
	return {
		async append(record) {
			records.push(structuredClone(record));
		},
		async list(trainableId) {
			return structuredClone(
				trainableId === undefined ? records : records.filter((record) => record.trainableId === trainableId),
			);
		},
	};
}
