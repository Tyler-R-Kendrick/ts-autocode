import { annotateRewrite, declaringContainer, dispatchRewrite } from "ts-autocode-rewrite";
import { defineTrainable, trainableTokenFromSymbol, trainingMarker } from "ts-autocode-training";

// Instrumentation is where training's identities meet the rewrite engine's
// weaving. The training package knows nothing about interception; this package
// annotates and dispatches through ts-autocode-rewrite, whose configured
// interceptor (see providers/rewrite.ts) routes calls into runtime capture.

export type TrainableDecorator = <This, Args extends unknown[], Result>(
	method: (this: This, ...args: Args) => Result,
	context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
) => (this: This, ...args: Args) => Result;

const wrappedMarker = Symbol.for("ts-autocode.wrapped");

/** Decorator form: `@trainable()`. Pass a symbol (for example
 * `defineTrainable("acme.route").symbol`) to bind an explicit identity that
 * evals, tests, and `training.train` reuse to target this exact method. When
 * no symbol is provided, a token is auto-generated from the declaring class
 * and method name; `defineTrainable("Router.route").symbol` recreates the same
 * stable symbol anywhere. The method is woven through the rewrite engine under
 * the "use training" marker at first construction, so promoted candidates can
 * hot-swap it. */
export function trainable(identity?: symbol): TrainableDecorator {
	if (identity !== undefined && typeof identity !== "symbol") {
		throw new TypeError("trainable identity must be a symbol; omit it to infer from the decorated method");
	}
	const explicit = identity === undefined ? undefined : trainableTokenFromSymbol(identity);
	return function <This, Args extends unknown[], Result>(
		method: (this: This, ...args: Args) => Result,
		context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
	) {
		const name = String(context.name);
		context.addInitializer(function (this: This) {
			const owner = (context.static ? this : (this as object).constructor) as abstract new (...args: never[]) => unknown;
			// Infer from the class that actually declares the method, so a base method
			// first initialized through a subclass still resolves to Base.method. The
			// auto-generated token's Symbol.for symbol is recreatable via defineTrainable.
			const token = explicit ?? defineTrainable(`${declaringClassName(owner, name, context.static) ?? "Anonymous"}.${name}`);
			annotateRewrite(owner, name, token.id, trainingMarker);
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
	return wrapped as unknown as F;
}

/** Load-time instrumentation (`ts-autocode/register`): weave a directive-marked
 * class method through the rewrite engine. Idempotent. */
export function instrumentTrainable(
	owner: abstract new (...args: never[]) => unknown,
	methodName: string,
	id: string,
): void {
	annotateRewrite(owner, methodName, id, trainingMarker);
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
