import { InvalidTrainableIdentityError } from "./errors.js";

const tokenPrefix = "ts-autocode.trainable";

declare const trainableIdBrand: unique symbol;

export type TrainableId = string & { readonly [trainableIdBrand]: true };

export interface TrainableToken {
	readonly id: TrainableId;
	readonly symbol: symbol;
}

export type TrainableCallable = (...args: never[]) => unknown;

export type TrainableIdentity = symbol | TrainableToken | TrainableCallable;

export const trainableStamp = Symbol.for("ts-autocode.trainable.id");

export function stampTrainable<F>(fn: F, token: TrainableToken): F {
	if (typeof fn === "function") {
		Object.defineProperty(fn, trainableStamp, { value: token.id, configurable: true });
	}
	return fn;
}

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

const registered = new Map<symbol, TrainableToken>();

export function registerTrainable(identity: symbol, token: TrainableToken): TrainableToken {
	const existing = registered.get(identity);
	if (existing && existing.id !== token.id) {
		throw new InvalidTrainableIdentityError(
			`symbol ${String(identity)} is already registered to ${existing.id}; one symbol keys one trainable`,
		);
	}
	const bound = Object.freeze({ id: token.id, symbol: identity });
	registered.set(identity, bound);
	return bound;
}

export function toTrainableToken(identity: TrainableIdentity): TrainableToken {
	if (typeof identity === "symbol") {
		const bound = registered.get(identity);
		if (bound) return bound;
		if (Symbol.keyFor(identity) !== undefined) return trainableTokenFromSymbol(identity);
		throw new InvalidTrainableIdentityError(
			`symbol ${String(identity)} is not a registered trainable; @trainable(symbol) registers it at first construction of the declaring class`,
		);
	}
	if (typeof identity === "function") {
		const id = (identity as Partial<Record<typeof trainableStamp, unknown>>)[trainableStamp];
		if (typeof id === "string") return defineTrainable(id);
		throw new InvalidTrainableIdentityError(
			`function ${identity.name || "(anonymous)"} is not marked trainable; mark it with @trainable() or load-time instrumentation, or pass the trainable's symbol`,
		);
	}
	if (typeof (identity as TrainableToken | null)?.id === "string") return identity as TrainableToken;
	throw new InvalidTrainableIdentityError("trainable identity must be a symbol or TrainableToken; create one with defineTrainable(id)");
}

export function trainableIdFromKey(key: string): string {
	return key.startsWith(`${tokenPrefix}:`) ? key.slice(tokenPrefix.length + 1) : key;
}

export function trainableTokenFromSymbol(identity: symbol): TrainableToken {
	const key = Symbol.keyFor(identity) ?? identity.description ?? "";
	if (!key.trim()) throw new InvalidTrainableIdentityError("trainable symbol must carry a registry key or description");
	return defineTrainable(trainableIdFromKey(key));
}
