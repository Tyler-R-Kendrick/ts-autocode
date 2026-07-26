import ts from "typescript";

import { inferredIntent } from "./decorators.js";

// AST scanner for ambient trainable declarations. An `export declare class`
// is erased at compile time — no decorator ever runs — so the syntax below
// is honored statically:
//
//   @trainable
//   export declare class Program {
//     @intent("Produce a simple hello-world program")
//     @returns("Hello World! or Hello, <name>! when supplied")
//     trainableMethod(
//       @description("Optional person to greet")
//       name?: string,
//     ): string;
//   }
//
// Every decorator is optional: a bare `@trainable declare class` with
// undecorated method signatures still scans — intent is inferred and the
// TypeScript signature is the declared shape. The scan result feeds
// codegen (`generateDeclaredRegistrations` emits registration source).
// Non-ambient decorated classes scan identically. Parsing is a real
// TypeScript AST walk (decorators on ambient members are grammar errors
// but survive in the parse tree), never regex.

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

/** Scan source for `@trainable` classes (ambient or not) and their declared operations. */
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
	for (const member of node.members) {
		if (!ts.isMethodDeclaration(member) || !member.name) continue;
		const method = memberName(member.name, sourceFile);
		if (method === "constructor") continue;
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
	/** Module specifier the emitted `import { training } from …` uses. */
	readonly runtimeModule?: string;
	/** Leading comment lines (verbatim, with `//`) above the import. */
	readonly header?: readonly string[];
}

const defaultHeader: readonly string[] = [
	"// Generated from an ambient trainable declaration — do not edit by hand.",
];

/**
 * Generate the `training.define` registration source for a scanned class.
 * The declared TypeScript signature becomes the contract's shape
 * descriptors, so the registration grounds (shape present) even with every
 * decorator omitted.
 */
export function generateDeclaredRegistrations(
	declared: DeclaredTrainableClass,
	emit: RegistrationEmitOptions = {},
): string {
	const lines: string[] = [
		...(emit.header ?? defaultHeader),
		`import { training } from ${JSON.stringify(emit.runtimeModule ?? "ts-autocode")};`,
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
		lines.push(`export const ${op.method} = training.define(${JSON.stringify(options, null, "\t")});`, "");
	}
	return lines.join("\n");
}
