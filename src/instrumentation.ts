import { annotateRewrite, declaringContainer, dispatchRewrite } from "ts-autocode-rewrite";
import {
	defineTrainable,
	InvalidTrainableIdentityError,
	registerTrainable,
	stampTrainable,
	trainableTokenFromSymbol,
	trainingMarker,
} from "ts-autocode-training";


export type TrainableDecorator = <This, Args extends unknown[], Result>(
	method: (this: This, ...args: Args) => Result,
	context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
) => (this: This, ...args: Args) => Result;

const wrappedMarker = Symbol.for("ts-autocode.wrapped");

export function trainable(identity?: symbol): TrainableDecorator {
	if (identity !== undefined && typeof identity !== "symbol") {
		throw new InvalidTrainableIdentityError("trainable identity must be a symbol; omit it to infer from the decorated method");
	}
	const explicit = identity !== undefined && Symbol.keyFor(identity) !== undefined
		? trainableTokenFromSymbol(identity)
		: undefined;
	return function <This, Args extends unknown[], Result>(
		method: (this: This, ...args: Args) => Result,
		context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
	) {
		const name = String(context.name);
		context.addInitializer(function (this: This) {
			const owner = (context.static ? this : (this as object).constructor) as abstract new (...args: never[]) => unknown;
			const inferred = defineTrainable(`${declaringClassName(owner, name, context.static) ?? "Anonymous"}.${name}`);
			const token = identity !== undefined && explicit === undefined
				? registerTrainable(identity, inferred)
				: explicit ?? inferred;
			annotateRewrite(owner, name, token.id, trainingMarker);
			stampTrainable(method, token);
			const container = (context.static ? owner : owner.prototype) as Record<string, unknown> | undefined;
			if (container && typeof container[name] === "function") stampTrainable(container[name], token);
		});
		return method;
	};
}

export function wrapTrainable<F extends (...args: never[]) => unknown>(fn: F, id: string): F {
	if ((fn as Partial<Record<typeof wrappedMarker, boolean>>)[wrappedMarker]) return fn;
	const name = fn.name || id;
	const method = fn as unknown as (this: unknown, ...args: unknown[]) => unknown;
	const wrapped = function (this: unknown, ...args: unknown[]): unknown {
		return dispatchRewrite(id, trainingMarker, name, method, this, args);
	};
	Object.defineProperty(wrapped, "name", { value: name, configurable: true });
	Object.defineProperty(wrapped, wrappedMarker, { value: true });
	stampTrainable(wrapped, defineTrainable(id));
	return wrapped as unknown as F;
}

export function instrumentTrainable(
	owner: abstract new (...args: never[]) => unknown,
	methodName: string,
	identity: string | symbol,
): void {
	const derived = defineTrainable(`${owner.name || "Anonymous"}.${methodName}`);
	const token = typeof identity === "symbol"
		? (Symbol.keyFor(identity) !== undefined ? trainableTokenFromSymbol(identity) : registerTrainable(identity, derived))
		: defineTrainable(identity);
	annotateRewrite(owner, methodName, token.id, trainingMarker);
	const container = declaringContainer(owner, methodName) as Record<string, unknown> | undefined;
	if (container && typeof container[methodName] === "function") {
		stampTrainable(container[methodName], token);
	}
}

function declaringClassName(
	owner: abstract new (...args: never[]) => unknown,
	methodName: string,
	isStatic: boolean,
): string | undefined {
	const container = declaringContainer(owner, methodName);
	const constructor = isStatic ? container : (container as { constructor?: unknown } | undefined)?.constructor;
	return typeof constructor === "function" && constructor.name ? constructor.name : undefined;
}
