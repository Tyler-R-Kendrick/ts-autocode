import { AnnotationFactory, AnnotationKind } from "@aspectjs/common";
import { Around, Aspect, getWeaver, on, type AroundContext, type JoinPoint } from "@aspectjs/core";

/** Marks a method for the weaver. Carries the stable id and the configured
 * marker (e.g. `"use audit"`) so dispatch can look up that marker's config.
 * Applied programmatically by `annotateRewrite`, never with decorator syntax,
 * so it does not depend on any compiler decorator configuration. */
const Rewrite = new AnnotationFactory("ts-autocode").create(
	AnnotationKind.METHOD,
	"Rewrite",
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	function Rewrite(id: string, marker: string) {},
);

export interface RewriteInvocation {
	readonly id: string;
	readonly marker: string;
	readonly methodName: string;
	readonly thisValue: unknown;
	readonly args: readonly unknown[];
	/** Runs the live implementation: the hot-swapped candidate when one is active,
	 * otherwise the original joinpoint. */
	readonly proceed: (...args: unknown[]) => unknown;
}

export type RewriteInterceptor = (invocation: RewriteInvocation) => unknown;

/** A marker's rewrite behavior. Registered once by the consumer (for example
 * an auditing consumer registers `"use audit"` with a logging interceptor);
 * `"use <name>"` in source is the shorthand that selects this configuration. */
export interface RewriteConfig {
	readonly marker: string;
	readonly intercept?: RewriteInterceptor;
}

type AnyMethod = (this: unknown, ...args: unknown[]) => unknown;

const configs = new Map<string, RewriteConfig>();
const swaps = new Map<string, AnyMethod>();

/** Normalizes a `"use <name>"` directive to its canonical single-spaced form.
 * Package-internal: emit.ts validates rewriter markers with it; not re-exported. */
export function normalizeMarker(marker: string): string {
	const trimmed = marker.trim().replace(/\s+/g, " ");
	if (!/^use \S/.test(trimmed)) throw new TypeError(`rewrite marker must be a "use <name>" directive: ${marker}`);
	return trimmed;
}

/** Single configuration entry point: binds a `"use <name>"` marker to its rewrite
 * behavior. After this, marking a method with that directive is all a consumer
 * needs — weaving and swapping happen through the configured behavior, not
 * through explicit `annotateRewrite`/`swapImplementation` calls. */
export function configureRewrite(config: RewriteConfig): void {
	const marker = normalizeMarker(config.marker);
	configs.set(marker, Object.freeze({ ...config, marker }));
}

/** Hot-swappable advice: replaces the live implementation for a rewrite id.
 * Every woven call dispatches through the swap, without touching source.
 * Consumers typically drive this when they commit a rewrite; it is exported
 * for tests and advanced orchestration, not the default consumer path. */
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
 * then the marker's configured interceptor, then the original implementation. */
export function dispatchRewrite(
	id: string,
	marker: string,
	methodName: string,
	original: AnyMethod,
	thisValue: unknown,
	args: readonly unknown[],
): unknown {
	const proceed = (...next: unknown[]): unknown => {
		const active = swaps.get(id) ?? original;
		return active.apply(thisValue, next.length > 0 ? next : [...args]);
	};
	const config = configs.get(safeNormalize(marker));
	if (!config?.intercept) return proceed();
	return config.intercept(Object.freeze({ id, marker: safeNormalize(marker), methodName, thisValue, args, proceed }));
}

function safeNormalize(marker: string): string {
	try {
		return normalizeMarker(marker);
	} catch {
		return marker;
	}
}

class RewriteAspectImpl {
	intercept(context: AroundContext, joinpoint: JoinPoint, args: unknown[]): unknown {
		const found = context.annotations(Rewrite).find()[0];
		const id = String(found?.args?.[0] ?? "");
		const marker = String(found?.args?.[1] ?? "");
		const methodName = String((context.target as { propertyKey?: unknown }).propertyKey ?? id);
		const original: AnyMethod = (...next: unknown[]) => joinpoint(...next);
		return dispatchRewrite(id, marker, methodName, original, context.instance, args);
	}
}

let wovenWeaver: unknown;

/** Idempotent per weaver context; `configureTesting(WeaverModule)` swaps the
 * context, after which the next annotate re-enables the aspect. */
function enableRewriteWeaving(): void {
	const weaver = getWeaver();
	if (weaver === wovenWeaver) return;
	wovenWeaver = weaver;
	decorateMethod(Around(on.methods.withAnnotations(Rewrite)), RewriteAspectImpl.prototype, "intercept");
	const Enhanced = (Aspect()(RewriteAspectImpl) ?? RewriteAspectImpl) as typeof RewriteAspectImpl;
	weaver.enable(new Enhanced());
}

const annotatedMethods = new WeakMap<object, Set<string>>();

/** Weaves a class (or static) method for hot-swappable rewrite dispatch under a
 * marker. Consumers do not call this directly: the `"use <name>"` directive (via
 * a consumer's discovery/register hook or decorator) is the shorthand that drives
 * it. Walks the prototype chain to the owning container; idempotent per method. */
export function annotateRewrite(
	owner: abstract new (...args: never[]) => unknown,
	methodName: string,
	id: string,
	marker = "",
): void {
	const container = declaringContainer(owner, methodName);
	if (!container) return;
	const marked = annotatedMethods.get(container) ?? new Set<string>();
	if (marked.has(methodName)) return;
	marked.add(methodName);
	annotatedMethods.set(container, marked);
	enableRewriteWeaving();
	decorateMethod(Rewrite(id, marker) as DescriptorDecorator, container, methodName);
}

/** The prototype (or the constructor itself, for statics) that declares `methodName`. */
export function declaringContainer(
	owner: abstract new (...args: never[]) => unknown,
	methodName: string,
): object | undefined {
	let container: object | null = Object.hasOwn(owner, methodName) ? owner : owner.prototype as object;
	while (container && container !== Object.prototype) {
		const method = Object.getOwnPropertyDescriptor(container, methodName)?.value as unknown;
		if (typeof method === "function") return container;
		container = Object.getPrototypeOf(container) as object | null;
	}
	return undefined;
}

/** AspectJS annotations decorate through the `(target, propertyKey, descriptor)`
 * calling convention when applied programmatically. */
type DescriptorDecorator = (
	target: object,
	propertyKey: string,
	descriptor: PropertyDescriptor,
) => PropertyDescriptor | void;

function decorateMethod(decorator: DescriptorDecorator, target: object, methodName: string): void {
	const descriptor = Object.getOwnPropertyDescriptor(target, methodName);
	if (!descriptor) return;
	const result = decorator(target, methodName, descriptor);
	if (result) Object.defineProperty(target, methodName, result);
}
