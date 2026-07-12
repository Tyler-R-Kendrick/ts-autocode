import ts from "typescript";

import { normalizeMarker } from "./aspect.js";
import { instrumentKey, type InstrumentTarget, type Marker } from "./instrument.js";

const { factory } = ts;

/** Load-hook rewriter: appends one data-driven registration statement for the
 * marker's discovered targets. Append-only, so line numbers and sourcemaps of the
 * original module are untouched; returns the source unchanged when the marker is
 * absent, discovery throws, or nothing instrumentable is found. */
export function createRewriter(
	discover: (source: string, path: string) => readonly InstrumentTarget[],
	marker: Marker,
): (source: string, path: string) => string {
	const directive = normalizeMarker(marker);
	return (source, path) => {
		if (!source.includes(directive)) return source;
		let targets: readonly InstrumentTarget[];
		try {
			targets = discover(source, path).filter(isInstrumentable);
		} catch {
			return source;
		}
		if (targets.length === 0) return source;
		return `${source}\n;${emitInstrumentation(targets)}\n`;
	};
}

/** Renders the registration statement for the targets. Built entirely from
 * ts.factory nodes and rendered with the TypeScript printer — syntactic validity
 * by construction, no string templates. The statement binds nothing (a single
 * optional call), so it cannot collide with names in the instrumented module:
 *
 *   globalThis[Symbol.for("ts-autocode.instrument")]?.([
 *       { id: "Router.route", name: "route", owner: () => Router },
 *       { id: "normalize", get: () => normalize, set: (__fn) => { normalize = __fn; } }
 *   ]);
 */
export function emitInstrumentation(targets: readonly InstrumentTarget[]): string {
	const statement = factory.createExpressionStatement(
		factory.createCallChain(
			registryExpression(),
			factory.createToken(ts.SyntaxKind.QuestionDotToken),
			undefined,
			[factory.createArrayLiteralExpression(targets.map(entryLiteral), true)],
		),
	);
	const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
	const container = ts.createSourceFile("instrumentation.js", "", ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
	return printer.printNode(ts.EmitHint.Unspecified, statement, container);
}

function isInstrumentable(target: InstrumentTarget): boolean {
	return isIdentifierName(target.methodName) && (target.className === undefined || isIdentifierName(target.className));
}

/** True when the whole string scans as one Identifier token (keywords excluded). */
function isIdentifierName(name: string): boolean {
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, name);
	return scanner.scan() === ts.SyntaxKind.Identifier && scanner.getTokenEnd() === name.length;
}

/** `globalThis[Symbol.for(instrumentKey)]` */
function registryExpression(): ts.Expression {
	return factory.createElementAccessExpression(
		factory.createIdentifier("globalThis"),
		factory.createCallExpression(
			factory.createPropertyAccessExpression(factory.createIdentifier("Symbol"), "for"),
			undefined,
			[factory.createStringLiteral(instrumentKey)],
		),
	);
}

function entryLiteral(target: InstrumentTarget): ts.ObjectLiteralExpression {
	const id = factory.createPropertyAssignment("id", factory.createStringLiteral(target.id));
	if (target.className !== undefined) {
		return factory.createObjectLiteralExpression([
			id,
			factory.createPropertyAssignment("name", factory.createStringLiteral(target.methodName)),
			factory.createPropertyAssignment("owner", accessor(identifier(target.className))),
		]);
	}
	return factory.createObjectLiteralExpression([
		id,
		factory.createPropertyAssignment("get", accessor(identifier(target.methodName))),
		factory.createPropertyAssignment("set", setter(target.methodName)),
	]);
}

/** `() => <expression>` */
function accessor(expression: ts.Expression): ts.ArrowFunction {
	return factory.createArrowFunction(
		undefined,
		undefined,
		[],
		undefined,
		factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
		expression,
	);
}

/** `(__fn) => { <name> = __fn; }` — `__fn` is a parameter, so its own scope. */
function setter(name: string): ts.ArrowFunction {
	return factory.createArrowFunction(
		undefined,
		undefined,
		[factory.createParameterDeclaration(undefined, undefined, factory.createIdentifier("__fn"))],
		undefined,
		factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
		factory.createBlock([
			factory.createExpressionStatement(factory.createAssignment(identifier(name), factory.createIdentifier("__fn"))),
		]),
	);
}

function identifier(name: string): ts.Identifier {
	if (!isIdentifierName(name)) {
		throw new TypeError(`instrument target must be a plain identifier: ${name}`);
	}
	return factory.createIdentifier(name);
}
