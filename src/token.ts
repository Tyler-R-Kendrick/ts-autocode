const tokenPrefix = "ts-autocode.trainable";

declare const trainableIdBrand: unique symbol;

/** Stable, serializable identity used across regions, traces, evals, and candidates. */
export type TrainableId = string & { readonly [trainableIdBrand]: true };

/** Runtime identity pairs a durable id with a stable JavaScript symbol. */
export interface TrainableToken {
	readonly id: TrainableId;
	readonly symbol: symbol;
}

export function defineTrainable(id: string): TrainableToken {
	const normalized = id.trim();
	if (!normalized) {
		throw new TypeError("trainable id must be a non-empty string");
	}
	return Object.freeze({
		id: normalized as TrainableId,
		symbol: Symbol.for(`${tokenPrefix}:${normalized}`),
	});
}
