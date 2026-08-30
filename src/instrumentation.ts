import { annotateRewrite, declaringContainer, dispatchRewrite } from "ts-autocode-rewrite";
import {
	defineTrainable,
	InvalidTrainableIdentityError,
	registerTrainable,
	stampTrainable,
	trainableTokenFromSymbol,
	trainingMarker,
} from "ts-autocode-training";

// Instrumentation is where training's identities meet the rewrite engine's
// weaving. The training package knows nothing about interception; this package
// annotates and dispatches through ts-autocode-rewrite, whose configured
// interceptor (see providers/rewrite.ts) routes calls into runtime capture.

export type TrainableDecorator = <This, Args extends unknown[], Result>(
	method: (this: This, ...args: Args) => Result,
	context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
) => (this: This, ...args: Args) => Result;

const wrappedMarker = Symbol.for("ts-autocode.wrapped");

/** Decorator form: `@trainable(symbol)`. The symbol is the application's own
 * key -- declare a `unique symbol` (`const route = Symbol("route")`), put it
 * on the trainable code here, and reuse the same symbol at
 * `training.train(route)`: discovery is then plain symbol-key indexing, and
 * the symbol's object identity is the uniqueness guarantee. The durable id
 * the machinery needs (for stores and source rewriting) is derived from the
 * declaring class and method, never from anything the caller typed.
 *
 * With no symbol, the machinery both derives the id and mints the key. A
 * `Symbol.for` registry symbol is also accepted for the zero-config directive
 * flow, where ids come from parsed source. The method is woven through the
 * rewrite engine at first construction, so promoted candidates can hot-swap
 * it -- which is also when the symbol binding registers. */
export function trainable(identity?: symbol): TrainableDecorator {
	if (identity !== undefined && typeof identity !== "symbol") {
		throw new InvalidTrainableIdentityError("trainable identity must be a symbol; omit it to infer from the decorated method");
	}
	// A registry symbol carries its own durable id; a unique symbol gets one
	// derived from the declaration it decorates, at first construction.
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
			// Infer from the class that actually declares the method, so a base method
			// first initialized through a subclass still resolves to Base.method.
			const inferred = defineTrainable(`${declaringClassName(owner, name, context.static) ?? "Anonymous"}.${name}`);
			const token = identity !== undefined && explicit === undefined
				? registerTrainable(identity, inferred)
				: explicit ?? inferred;
			annotateRewrite(owner, name, token.id, trainingMarker);
			// Stamp both the original method and whatever weaving installed in its
			// slot, so `train({ trainable: Router.prototype.route })` resolves the
			// identity the marking machinery declared -- never a retyped string.
			stampTrainable(method, token);
			const container = (context.static ? owner : owner.prototype) as Record<string, unknown> | undefined;
			if (container && typeof container[name] === "function") stampTrainable(container[name], token);
		});
		return method;
	};
}

/** Load-time instrumentation (`ts-autocode/register`): wrap a directive-marked free
 * function through the same hot-swappable dispatch as woven methods. Idempotent. */
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

/** Weaves a directive-marked class method through the rewrite engine.
 *
 * With a **symbol**, this is exactly `@trainable(symbol)` without decorator
 * syntax -- for runtimes whose transforms cannot lower TC39 decorators yet:
 * the method registers under the application's own unique symbol, and the
 * durable id is derived from the class and method names, never typed. With a
 * **string**, it is the load-time machinery (`ts-autocode/register`) supplying
 * an id it derived from parsed source. Idempotent. */
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

/** Name of the class that declares `methodName`, walking to the owning prototype
 * so an inherited method resolves to its base class rather than a subclass. */
function declaringClassName(
	owner: abstract new (...args: never[]) => unknown,
	methodName: string,
	isStatic: boolean,
): string | undefined {
	const container = declaringContainer(owner, methodName);
	const constructor = isStatic ? container : (container as { constructor?: unknown } | undefined)?.constructor;
	return typeof constructor === "function" && constructor.name ? constructor.name : undefined;
}
