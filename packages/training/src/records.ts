import type { Trace } from "@agentv/core";

import type { TrainableId } from "./token.js";

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

export class MemoryTrainingStore implements TrainingStore {
	readonly #records: TrainingRecord[] = [];

	async append(record: TrainingRecord): Promise<void> {
		this.#records.push(structuredClone(record));
	}

	async list(trainableId?: TrainableId): Promise<readonly TrainingRecord[]> {
		return structuredClone(
			trainableId === undefined ? this.#records : this.#records.filter((record) => record.trainableId === trainableId),
		);
	}
}
