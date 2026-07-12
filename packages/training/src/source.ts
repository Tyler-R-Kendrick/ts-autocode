import { dirname, extname, resolve } from "node:path";

import ts from "typescript";

import { digest } from "./digest.js";
import { trainableIdFromKey, type TrainableId } from "./token.js";

/** A `"use <name>"` directive. Structural mirror of ts-autocode-rewrite's Marker,
 * so training markers apply anywhere a rewriter marker is expected. */
export type Marker = `use ${string}`;

/** The directive that marks a method for training; the marker training registers
 * with the wired weaver. */
export const trainingMarker: Marker = "use training";

/** Where `discoverTrainables` looks when `SourceSettings.tsconfig` is unset. */
export const defaultTsconfig = "tsconfig.json";

/** Artifact reference recorded for targets discovered from an in-memory string. */
export const inMemoryArtifactRef = "memory://source.ts";

// Source discovery recognizes this package's public API by name.
const trainableDecoratorName = "trainable";
const defineTrainableName = "defineTrainable";

export interface TrainableParameter {
	readonly name: string;
	readonly declaration: string;
	readonly type: string;
	readonly optional: boolean;
}

/** The decorated or directive-marked method body that may be rewritten. */
export interface TrainableTarget {
	readonly id: TrainableId;
	readonly artifactRef: string;
	readonly className?: string;
	readonly methodName: string;
	readonly signature: string;
	readonly parameters: readonly TrainableParameter[];
	readonly returnType: string;
	readonly async: boolean;
	readonly bodyStart: number;
	readonly bodyEnd: number;
	readonly bodyDigest: string;
	readonly implementation: string;
	readonly indentation: string;
}

export interface SourceSettings {
	readonly cwd?: string;
	readonly tsconfig?: string;
	readonly files?: readonly string[];
}

export function discoverTrainables(settings: SourceSettings = {}): readonly TrainableTarget[] {
	const cwd = resolve(settings.cwd ?? process.cwd());
	const files = settings.files?.map((file) => resolve(cwd, file)) ?? projectFiles(cwd, settings.tsconfig);
	return files.flatMap((file) => {
		const source = ts.sys.readFile(file);
		if (source === undefined) return [];
		const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
		const tokens = new Map([...tokenDeclarations(sourceFile), ...importedTokenDeclarations(sourceFile, file)]);
		return discoverSourceFile(sourceFile, file, tokens);
	});
}

export function findTrainable(id: TrainableId, settings: SourceSettings = {}): TrainableTarget {
	const matches = discoverTrainables(settings).filter((target) => target.id === id);
	if (matches.length !== 1) {
		throw new Error(
			matches.length === 0
				? `trainable source was not found: ${id}`
				: `trainable id must resolve to exactly one method: ${id}`,
		);
	}
	return matches[0] as TrainableTarget;
}

export function discoverInSource(source: string, artifactRef = inMemoryArtifactRef): readonly TrainableTarget[] {
	const sourceFile = ts.createSourceFile(artifactRef, source, ts.ScriptTarget.Latest, true, scriptKind(artifactRef));
	return discoverSourceFile(sourceFile, artifactRef);
}

function discoverSourceFile(
	sourceFile: ts.SourceFile,
	artifactRef: string,
	resolvedTokens?: ReadonlyMap<string, string>,
): readonly TrainableTarget[] {
	const tokenIds = resolvedTokens ?? tokenDeclarations(sourceFile);
	const targets: TrainableTarget[] = [];

	function visit(node: ts.Node, className?: string): void {
		if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
			const nextClass = node.name?.text ?? className;
			node.members.forEach((member) => visit(member, nextClass));
			return;
		}
		if (ts.isMethodDeclaration(node) && node.body && node.name) {
			const methodName = propertyName(node.name, sourceFile);
			const directive = firstDirective(node.body);
			const decorator = trainableDecorator(node);
			if (directive || decorator) {
				const decoratorId = decorator && trainableDecoratorId(decorator, sourceFile, tokenIds);
				targets.push(targetFor(node, sourceFile, artifactRef, decoratorId ?? `${className ?? "Anonymous"}.${methodName}`, className));
			}
			return;
		}
		if (ts.isFunctionDeclaration(node) && node.body && node.name && firstDirective(node.body)) {
			targets.push(targetFor(node, sourceFile, artifactRef, node.name.text));
			return;
		}
		ts.forEachChild(node, (child) => visit(child, className));
	}

	visit(sourceFile);
	return targets;
}

function targetFor(
	node: ts.MethodDeclaration | ts.FunctionDeclaration,
	sourceFile: ts.SourceFile,
	artifactRef: string,
	id: string,
	className?: string,
): TrainableTarget {
	if (node.asteriskToken) throw new TypeError(`generator methods cannot be trainable: ${artifactRef}`);
	const body = node.body as ts.Block;
	const directive = firstDirective(body);
	const bodyStart = directive?.end ?? body.getStart(sourceFile) + 1;
	const bodyEnd = body.end - 1;
	const implementation = sourceFile.text.slice(bodyStart, bodyEnd);
	const methodName = node.name?.getText(sourceFile) ?? "anonymous";
	const parameters = node.parameters.map((parameter, index): TrainableParameter => ({
		name: ts.isIdentifier(parameter.name) ? parameter.name.text : `arg${index}`,
		declaration: parameter.getText(sourceFile),
		type: parameter.type?.getText(sourceFile) ?? "unknown",
		optional: parameter.questionToken !== undefined || parameter.initializer !== undefined,
	}));
	const returnType = node.type?.getText(sourceFile) ?? "unknown";
	const signature = `${methodName}(${parameters.map(({ declaration }) => declaration).join(", ")}): ${returnType}`;
	const idValue = id.trim();
	if (!idValue) throw new TypeError("trainable id must be a non-empty string");
	return Object.freeze({
		id: idValue as TrainableId,
		artifactRef,
		...(className === undefined ? {} : { className }),
		methodName,
		signature,
		parameters,
		returnType,
		async: node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false,
		bodyStart,
		bodyEnd,
		bodyDigest: digest(implementation),
		implementation: implementation.trim(),
		indentation: lineIndentation(sourceFile.text, node.getStart(sourceFile)),
	});
}

function firstDirective(body: ts.Block): ts.ExpressionStatement | undefined {
	const statement = body.statements[0];
	return statement && ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression) &&
		statement.expression.text === trainingMarker
		? statement
		: undefined;
}

function trainableDecorator(node: ts.MethodDeclaration): ts.Decorator | undefined {
	return ts.getDecorators(node)?.find((item) => {
		const expression = ts.isCallExpression(item.expression) ? item.expression.expression : item.expression;
		return ts.isIdentifier(expression) && expression.text === trainableDecoratorName;
	});
}

/** Resolves an explicit decorator identity; undefined means infer from the method. */
function trainableDecoratorId(
	decorator: ts.Decorator,
	sourceFile: ts.SourceFile,
	tokens: ReadonlyMap<string, string>,
): string | undefined {
	if (!ts.isCallExpression(decorator.expression) || decorator.expression.arguments.length === 0) return undefined;
	const argument = decorator.expression.arguments[0] as ts.Expression;
	const id = symbolText(argument) ??
		(ts.isPropertyAccessExpression(argument) && ts.isIdentifier(argument.expression) && argument.name.text === "symbol"
			? tokens.get(argument.expression.text)
			: ts.isIdentifier(argument)
				? tokens.get(argument.text)
				: undefined);
	if (id === undefined) {
		throw new TypeError(
			`@trainable identity must be a symbol (defineTrainable(...).symbol or Symbol.for(...)) or omitted to infer in ${sourceFile.fileName}`,
		);
	}
	return id;
}

function symbolText(expression: ts.Expression): string | undefined {
	if (!ts.isCallExpression(expression)) return undefined;
	const callee = expression.expression;
	const isSymbol = (ts.isIdentifier(callee) && callee.text === "Symbol") ||
		(ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) &&
			callee.expression.text === "Symbol" && callee.name.text === "for");
	const value = expression.arguments[0];
	return isSymbol && value && ts.isStringLiteralLike(value) ? trainableIdFromKey(value.text) : undefined;
}

function tokenDeclarations(sourceFile: ts.SourceFile): ReadonlyMap<string, string> {
	const tokens = new Map<string, string>();
	for (const statement of sourceFile.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isCallExpression(declaration.initializer)) {
				continue;
			}
			if (!ts.isIdentifier(declaration.initializer.expression) || declaration.initializer.expression.text !== defineTrainableName) {
				continue;
			}
			const value = declaration.initializer.arguments[0];
			if (value && ts.isStringLiteralLike(value)) tokens.set(declaration.name.text, value.text);
		}
	}
	return tokens;
}

function importedTokenDeclarations(sourceFile: ts.SourceFile, artifactRef: string): ReadonlyMap<string, string> {
	const tokens = new Map<string, string>();
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		const bindings = statement.importClause?.namedBindings;
		if (!bindings || !ts.isNamedImports(bindings)) continue;
		const importedFile = resolveLocalImport(artifactRef, statement.moduleSpecifier.text);
		if (!importedFile) continue;
		const importedSource = ts.sys.readFile(importedFile);
		if (importedSource === undefined) continue;
		const imported = tokenDeclarations(
			ts.createSourceFile(importedFile, importedSource, ts.ScriptTarget.Latest, true, scriptKind(importedFile)),
		);
		for (const binding of bindings.elements) {
			const importedName = binding.propertyName?.text ?? binding.name.text;
			const id = imported.get(importedName);
			if (id) tokens.set(binding.name.text, id);
		}
	}
	return tokens;
}

function resolveLocalImport(artifactRef: string, specifier: string): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const base = resolve(dirname(artifactRef), specifier);
	const extension = extname(base);
	const candidates = extension
		? [base, base.slice(0, -extension.length) + ".ts", base.slice(0, -extension.length) + ".tsx"]
		: [`${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")];
	return candidates.find(ts.sys.fileExists);
}

function projectFiles(cwd: string, tsconfig = defaultTsconfig): readonly string[] {
	const configPath = resolve(cwd, tsconfig);
	const config = ts.readConfigFile(configPath, ts.sys.readFile);
	if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, cwd, undefined, configPath);
	if (parsed.errors.length > 0) {
		throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
	}
	return parsed.fileNames;
}

function lineIndentation(source: string, offset: number): string {
	const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
	return /^\s*/.exec(source.slice(lineStart, offset))?.[0] ?? "";
}

function propertyName(name: ts.PropertyName, sourceFile: ts.SourceFile): string {
	return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
		? name.text
		: name.getText(sourceFile);
}

function scriptKind(file: string): ts.ScriptKind {
	if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
	if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
	if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) return ts.ScriptKind.JS;
	return ts.ScriptKind.TS;
}
