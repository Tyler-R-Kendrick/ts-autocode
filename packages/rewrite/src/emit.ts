import ts from "typescript";

import { normalizeMarker } from "./aspect.js";
import { instrumentKey, type InstrumentTarget, type Marker } from "./instrument.js";

const { factory } = ts;

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

export function emitInstrumentation(targets: readonly InstrumentTarget[]): string {
	const statement = factory.createExpressionStatement(
		factory.createCallChain(
			registryExpression(),
			factory.createToken(ts.SyntaxKind.QuestionDotToken),
			undefined,
			[factory.createArrayLiteralExpression(targets.map(entryLiteral), true)],
		),
	);
	return printer.printNode(ts.EmitHint.Unspecified, statement, printContainer);
}

const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
const printContainer = ts.createSourceFile("instrumentation.js", "", ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);

function isInstrumentable(target: InstrumentTarget): boolean {
	return isIdentifierName(target.methodName) && (target.className === undefined || isIdentifierName(target.className));
}

function isIdentifierName(name: string): boolean {
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, name);
	return scanner.scan() === ts.SyntaxKind.Identifier && scanner.getTokenEnd() === name.length;
}

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
