import { AnnotationFactory, AnnotationKind } from "@aspectjs/common";
import { Around, Aspect, getWeaver, on, type AroundContext, type JoinPoint } from "@aspectjs/core";

const Rewrite = new AnnotationFactory("ts-autocode").create(
	AnnotationKind.METHOD,
	"Rewrite",
	function Rewrite(_id: string, _marker: string) {},
);

export interface RewriteInvocation {
	readonly id: string;
	readonly marker: string;
	readonly methodName: string;
	readonly thisValue: unknown;
	readonly args: readonly unknown[];
	readonly proceed: (...args: unknown[]) => unknown;
}

export type RewriteInterceptor = (invocation: RewriteInvocation) => unknown;

export interface RewriteConfig {
	readonly marker: string;
	readonly intercept?: RewriteInterceptor;
}

type AnyMethod = (this: unknown, ...args: unknown[]) => unknown;

const configs = new Map<string, RewriteConfig>();
const swaps = new Map<string, AnyMethod>();

export function normalizeMarker(marker: string): string {
	const trimmed = marker.trim().replace(/\s+/g, " ");
	if (!/^use \S/.test(trimmed)) throw new TypeError(`rewrite marker must be a "use <name>" directive: ${marker}`);
	return trimmed;
}

export function configureRewrite(config: RewriteConfig): void {
	const marker = normalizeMarker(config.marker);
	configs.set(marker, Object.freeze({ ...config, marker }));
}

export function swapImplementation(id: string, implementation: AnyMethod): void {
	swaps.set(id, implementation);
}

export function restoreImplementation(id: string): void {
	swaps.delete(id);
}

export function swappedImplementation(id: string): AnyMethod | undefined {
	return swaps.get(id);
}

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

function enableRewriteWeaving(): void {
	const weaver = getWeaver();
	if (weaver === wovenWeaver) return;
	wovenWeaver = weaver;
	decorateMethod(Around(on.methods.withAnnotations(Rewrite)), RewriteAspectImpl.prototype, "intercept");
	const Enhanced = (Aspect()(RewriteAspectImpl) ?? RewriteAspectImpl) as typeof RewriteAspectImpl;
	weaver.enable(new Enhanced());
}

const annotatedMethods = new WeakMap<object, Set<string>>();

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
