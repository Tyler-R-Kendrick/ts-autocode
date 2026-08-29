import { InvalidTrainableIdentityError } from "./errors.js";

const tokenPrefix = "ts-autocode.trainable";

declare const trainableIdBrand: unique symbol;

/** Stable, serializable identity used across methods, traces, evals, and candidates. */
export type TrainableId = string & { readonly [trainableIdBrand]: true };

/** Runtime identity pairs a durable id with a stable JavaScript symbol. */
export interface TrainableToken {
	readonly id: TrainableId;
	readonly symbol: symbol;
}

/** Public identity accepted by training APIs: the trainable's plain string id
 * (`"Router.route"` — what `ts-autocode discover` prints), its symbol, or its
 * full token. Strings were once rejected here on the theory that the branded
 * token was safer, but `defineTrainable(id)` is itself an unchecked string, so
 * the rejection bought no safety — only the `defineTrainable(id).symbol`
 * ceremony at every call site. */
export type TrainableIdentity = string | symbol | TrainableToken;

export function defineTrainable(id: string): TrainableToken {
	const normalized = id.trim();
	if (!normalized) {
		throw new InvalidTrainableIdentityError("trainable id must be a non-empty string");
	}
	return Object.freeze({
		id: normalized as TrainableId,
		symbol: Symbol.for(`${tokenPrefix}:${normalized}`),
	});
}

export function toTrainableToken(identity: TrainableIdentity): TrainableToken {
	if (typeof identity === "string") return defineTrainable(identity);
	if (typeof identity === "symbol") return trainableTokenFromSymbol(identity);
	if (typeof (identity as TrainableToken | null)?.id === "string") return identity;
	throw new InvalidTrainableIdentityError("trainable identity must be a string id, symbol, or TrainableToken");
}

/** Strips the library prefix so registered symbols and raw ids share one durable id space. */
export function trainableIdFromKey(key: string): string {
	return key.startsWith(`${tokenPrefix}:`) ? key.slice(tokenPrefix.length + 1) : key;
}

export function trainableTokenFromSymbol(identity: symbol): TrainableToken {
	const key = Symbol.keyFor(identity) ?? identity.description ?? "";
	if (!key.trim()) throw new InvalidTrainableIdentityError("trainable symbol must carry a registry key or description");
	return defineTrainable(trainableIdFromKey(key));
}
