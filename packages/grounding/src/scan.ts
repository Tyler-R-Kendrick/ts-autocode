import ts from "typescript";

import { inferredIntent } from "./decorators.js";


export interface DeclaredParameter {
	readonly name: string;
	readonly type: string;
	readonly optional: boolean;
	readonly description?: string;
}

export interface DeclaredOperation {
	readonly methodRef: string;
	readonly method: string;
	readonly intent: string;
	readonly inferredIntent: boolean;
	readonly returns?: string;
	readonly contractRef: string;
	readonly parameters: readonly DeclaredParameter[];
	readonly outputType: string;
}

export interface DeclaredTrainableClass {
	readonly className: string;
	readonly ambient: boolean;
	readonly operations: readonly DeclaredOperation[];
}

const markerDecoratorNames = new Set(["trainable", "component"]);

export function scanDeclaredTrainables(source: string): readonly DeclaredTrainableClass[] {
	if (typeof source !== "string") {
		throw new TypeError("source must be a string");
	}
	const sourceFile = ts.createSourceFile("declared.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const classes: DeclaredTrainableClass[] = [];

	function visit(node: ts.Node): void {
		if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name && markedTrainable(node)) {
			classes.push({
				className: node.name.text,
				ambient: node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) ?? false,
				operations: scanOperations(node, sourceFile),
			});
			return;
		}
		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return classes;
}

function markedTrainable(node: ts.ClassDeclaration | ts.ClassExpression): boolean {
	return (
		ts.getDecorators(node)?.some((decorator) => {
			const expression = ts.isCallExpression(decorator.expression)
				? decorator.expression.expression
				: decorator.expression;
			return ts.isIdentifier(expression) && markerDecoratorNames.has(expression.text);
		}) ?? false
	);
}

function scanOperations(
	node: ts.ClassDeclaration | ts.ClassExpression,
	sourceFile: ts.SourceFile,
): readonly DeclaredOperation[] {
	const className = node.name?.text ?? "Anonymous";
	const operations: DeclaredOperation[] = [];
	const seen = new Set<string>();
	for (const member of node.members) {
		if (!ts.isMethodDeclaration(member) || !member.name) continue;
		const method = memberName(member.name, sourceFile);
		if (method === "constructor") continue;
		if (!/^[A-Za-z_$][\w$]*$/.test(method)) {
			throw new TypeError(`trainable method name must be a plain identifier: ${className}.${method}`);
		}
		if (seen.has(method)) {
			throw new TypeError(`trainable method scans to a duplicate name (overload signatures?): ${className}.${method}`);
		}
		seen.add(method);
		const methodRef = `${className}.${method}`;
		const declaredIntent = decoratorText(ts.getDecorators(member), "intent", sourceFile);
		const declaredReturns = decoratorText(ts.getDecorators(member), "returns", sourceFile);
		operations.push({
			methodRef,
			method,
			intent: declaredIntent ?? inferredIntent(methodRef),
			inferredIntent: declaredIntent === undefined,
			...(declaredReturns !== undefined ? { returns: declaredReturns } : {}),
			contractRef: `decl://${methodRef}`,
			parameters: member.parameters.map((parameter, index) => scanParameter(parameter, index, sourceFile)),
			outputType: member.type?.getText(sourceFile).trim() ?? "unknown",
		});
	}
	return operations;
}

function scanParameter(parameter: ts.ParameterDeclaration, index: number, sourceFile: ts.SourceFile): DeclaredParameter {
	const description = decoratorText(ts.getDecorators(parameter), "description", sourceFile);
	return {
		name: ts.isIdentifier(parameter.name) ? parameter.name.text : `arg${index}`,
		optional: parameter.questionToken !== undefined || parameter.initializer !== undefined,
		type: parameter.type?.getText(sourceFile).trim() ?? "unknown",
		...(description !== undefined ? { description } : {}),
	};
}

function decoratorText(
	decorators: readonly ts.Decorator[] | undefined,
	name: string,
	sourceFile: ts.SourceFile,
): string | undefined {
	for (const decorator of decorators ?? []) {
		if (!ts.isCallExpression(decorator.expression)) continue;
		const callee = decorator.expression.expression;
		if (!ts.isIdentifier(callee) || callee.text !== name) continue;
		const argument = decorator.expression.arguments[0];
		if (argument && ts.isStringLiteralLike(argument)) return argument.text;
		if (argument && ts.isNoSubstitutionTemplateLiteral(argument)) return argument.text;
		return argument?.getText(sourceFile);
	}
	return undefined;
}

function memberName(name: ts.PropertyName, sourceFile: ts.SourceFile): string {
	return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
		? name.text
		: name.getText(sourceFile);
}

export interface RegistrationEmitOptions {
	readonly runtimeModule?: string;
	readonly header?: readonly string[];
}

export function generateDeclaredRegistrations(
	declared: DeclaredTrainableClass,
	emit: RegistrationEmitOptions = {},
): string {
	const lines: string[] = [
		...(emit.header ?? []),
		`import { defineGrounding } from ${JSON.stringify(emit.runtimeModule ?? "ts-autocode/grounding")};`,
		"",
	];
	for (const op of declared.operations) {
		const input = Object.fromEntries(
			op.parameters.map((p) => [
				p.name,
				{
					type: p.type,
					optional: p.optional,
					...(p.description ? { description: p.description } : {}),
				},
			]),
		);
		const params = Object.fromEntries(
			op.parameters.filter((p) => p.description).map((p) => [p.name, { description: p.description }]),
		);
		const options = {
			methodRef: op.methodRef,
			intent: op.intent,
			contract: {
				ref: op.contractRef,
				input,
				output: {
					type: op.outputType,
					...(op.returns ? { description: op.returns } : {}),
				},
			},
			...(Object.keys(params).length > 0 ? { params } : {}),
			...(op.returns ? { output: { returns: { description: op.returns } } } : {}),
		};
		lines.push(`export const ${op.method} = defineGrounding(${JSON.stringify(options, null, "\t")});`, "");
	}
	return lines.join("\n");
}
