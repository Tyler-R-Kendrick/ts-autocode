import { AnnotationFactory, AnnotationKind } from "@aspectjs/common";
import { Around, Aspect, getWeaver, on, type AroundContext, type JoinPoint } from "@aspectjs/core";

/** Marks a method as trainable for the weaver. Applied programmatically by
 * `annotateTrainable`, never with decorator syntax, so it works under both
 * standard and legacy decorator configurations. */
export const Trainable = new AnnotationFactory("ts-autocode").create(
	AnnotationKind.METHOD,
	"Trainable",
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	function Trainable(id: string) {},
);

export interface TrainableInvocation {
	readonly id: string;
	readonly methodName: string;
	readonly thisValue: unknown;
	readonly args: readonly unknown[];
	/** Runs the live implementation: the hot-swapped candidate when one is active,
	 * otherwise the original joinpoint. */
	readonly proceed: (...args: unknown[]) => unknown;
}

export type TrainableInterceptor = (invocation: TrainableInvocation) => unknown;

type AnyMethod = (this: unknown, ...args: unknown[]) => unknown;

let interceptor: TrainableInterceptor | undefined;
const swaps = new Map<string, AnyMethod>();

/** One interceptor per process observes every trainable invocation
 * (ts-autocode-training wires runtime capture here). */
export function setTrainableInterceptor(next: TrainableInterceptor | undefined): void {
	interceptor = next;
}

/** Hot-swappable advice: replaces the live implementation for a trainable id.
 * Every woven call dispatches through the swap, without touching source. */
export function swapImplementation(id: string, implementation: AnyMethod): void {
	swaps.set(id, implementation);
}

export function restoreImplementation(id: string): void {
	swaps.delete(id);
}

export function swappedImplementation(id: string): AnyMethod | undefined {
	return swaps.get(id);
}

/** Shared dispatch for the aspect and for wrapped free functions: hot-swap first,
 * then the interceptor, then the original implementation. */
export function dispatchTrainable(
	id: string,
	methodName: string,
	original: AnyMethod,
	thisValue: unknown,
	args: readonly unknown[],
): unknown {
	const proceed = (...next: unknown[]): unknown => {
		const active = swaps.get(id) ?? original;
		return active.apply(thisValue, next.length > 0 ? next : [...args]);
	};
	if (!interceptor) return proceed();
	return interceptor(Object.freeze({ id, methodName, thisValue, args, proceed }));
}

class TrainableAspectImpl {
	intercept(context: AroundContext, joinpoint: JoinPoint, args: unknown[]): unknown {
		const found = context.annotations(Trainable).find()[0];
		const id = String(found?.args?.[0] ?? "");
		const methodName = String((context.target as { propertyKey?: unknown }).propertyKey ?? id);
		const original: AnyMethod = (...next: unknown[]) => joinpoint(...next);
		return dispatchTrainable(id, methodName, original, context.instance, args);
	}
}

let wovenWeaver: unknown;

/** Idempotent per weaver context; `configureTesting(WeaverModule)` swaps the
 * context, after which the next annotate re-enables the aspect. */
export function enableTrainableWeaving(): void {
	const weaver = getWeaver();
	if (weaver === wovenWeaver) return;
	wovenWeaver = weaver;
	applyLegacyDecorator(Around(on.methods.withAnnotations(Trainable)), TrainableAspectImpl.prototype, "intercept");
	const Enhanced = (Aspect()(TrainableAspectImpl) ?? TrainableAspectImpl) as typeof TrainableAspectImpl;
	weaver.enable(new Enhanced());
}

const annotatedMethods = new WeakMap<object, Set<string>>();

/** Weaves a class (or static) method for hot-swappable trainable dispatch.
 * Walks the prototype chain to the owning container; idempotent per method. */
export function annotateTrainable(
	owner: abstract new (...args: never[]) => unknown,
	methodName: string,
	id: string,
): void {
	const container = owningContainer(owner, methodName);
	if (!container) return;
	const marked = annotatedMethods.get(container) ?? new Set<string>();
	if (marked.has(methodName)) return;
	marked.add(methodName);
	annotatedMethods.set(container, marked);
	enableTrainableWeaving();
	applyLegacyDecorator(Trainable(id) as LegacyMethodDecorator, container, methodName);
}

type LegacyMethodDecorator = (
	target: object,
	propertyKey: string,
	descriptor: PropertyDescriptor,
) => PropertyDescriptor | void;

function applyLegacyDecorator(decorator: LegacyMethodDecorator, target: object, methodName: string): void {
	const descriptor = Object.getOwnPropertyDescriptor(target, methodName);
	if (!descriptor) return;
	const result = decorator(target, methodName, descriptor);
	if (result) Object.defineProperty(target, methodName, result);
}

function owningContainer(owner: abstract new (...args: never[]) => unknown, methodName: string): object | undefined {
	let container: object | null = Object.hasOwn(owner, methodName) ? owner : owner.prototype as object;
	while (container && container !== Object.prototype) {
		const method = Object.getOwnPropertyDescriptor(container, methodName)?.value as unknown;
		if (typeof method === "function") return container;
		container = Object.getPrototypeOf(container) as object | null;
	}
	return undefined;
}
