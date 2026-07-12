const tokenPrefix = "ts-autocode.trainable";

declare const trainableIdBrand: unique symbol;

/** Stable, serializable identity used across methods, traces, evals, and candidates. */
export type TrainableId = string & { readonly [trainableIdBrand]: true };

/** Runtime identity pairs a durable id with a stable JavaScript symbol. */
export interface TrainableToken {
	readonly id: TrainableId;
	readonly symbol: symbol;
}

export type TrainableIdentity = string | TrainableToken;

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

export function toTrainableToken(identity: TrainableIdentity): TrainableToken {
	return typeof identity === "string" ? defineTrainable(identity) : identity;
}

/** Strips the library prefix so registered symbols and raw ids share one durable id space. */
export function trainableIdFromKey(key: string): string {
	return key.startsWith(`${tokenPrefix}:`) ? key.slice(tokenPrefix.length + 1) : key;
}

export function trainableTokenFromSymbol(identity: symbol): TrainableToken {
	const key = Symbol.keyFor(identity) ?? identity.description ?? "";
	if (!key.trim()) throw new TypeError("trainable symbol must carry a registry key or description");
	return defineTrainable(trainableIdFromKey(key));
}
