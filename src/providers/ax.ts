import {
	ai,
	ax,
	optimize as optimizeWithAx,
	type AxAIService,
	type AxField,
	type AxFieldValue,
	type AxOptimizeOptions,
} from "@ax-llm/ax";

import type { EngineContext, OptimizeRequest, TrainingEngine } from "ts-autocode-training";

import { executeImplementation } from "../execution.js";

type Service = AxAIService | ((context: EngineContext) => AxAIService | Promise<AxAIService>);

const field = {
	args: "trainingArgumentsJson",
	current: "currentMethodImplementation",
	expected: "expectedMethodOutput",
	objective: "trainingObjective",
	output: "optimizedMethodImplementation",
} as const;

export interface AxEngineOptions {
	readonly id?: string;
	readonly studentAI?: Service;
	readonly teacherAI?: Service;
	readonly optimize?: Omit<AxOptimizeOptions, "studentAI" | "teacherAI">;
	readonly executionTimeoutMs?: number;
}

type RewriteInput = Record<string, AxFieldValue>;

type RewriteOutput = { [field.output]: string };

/** Default engine: the Ax program, examples, and metric come from the trainable method. */
export function createAxEngine(options: AxEngineOptions = {}): TrainingEngine {
	const engine: TrainingEngine = {
		id: options.id ?? "@ax-llm/ax",
		async optimize(request: OptimizeRequest, context: EngineContext) {
			const studentAI = await service(options.studentAI, context);
			const teacherAI = options.teacherAI === undefined ? undefined : await service(options.teacherAI, context);
			const examples = trainingExamples(request);
			if (examples.length === 0) {
				throw new Error(`Ax requires captured calls or AgentV evaluations for ${request.trainableId}`);
			}
			const program = ax(programSignature(request));
			const result = await optimizeWithAx(program, examples, ({ prediction, example }) =>
				scoreImplementation(request, prediction as RewriteOutput, example, options.executionTimeoutMs, context.signal), {
				...options.optimize,
				studentAI,
				...(teacherAI === undefined ? {} : { teacherAI }),
			});
			if (!result.optimizedProgram) throw new Error(`Ax did not optimize ${request.trainableId}`);
			program.applyOptimization(result.optimizedProgram);
			const output = await program.forward(studentAI, publicInput(examples[0] as Record<string, AxFieldValue>), {
				...(context.signal === undefined ? {} : { abortSignal: context.signal }),
			}) as RewriteOutput;
			return {
				implementation: output[field.output],
				metadata: {
					bestScore: result.bestScore,
					optimizerType: result.optimizedProgram.optimizerType,
					converged: result.optimizedProgram.converged,
					rounds: result.optimizedProgram.totalRounds,
				},
			};
		},
	};
	return Object.freeze(engine);
}

function programSignature(request: OptimizeRequest): { description: string; inputs: readonly AxField[]; outputs: readonly AxField[] } {
	return {
		description: [
			`Rewrite only the TypeScript body of ${request.target.signature}.`,
			request.objective,
			...(request.constraints ?? []),
			"Return the method body without braces or markdown fences.",
		].join("\n"),
		inputs: [
			...parameterFields(request).map(({ parameter, name }): AxField => ({
				name,
				description: parameter.declaration,
				type: fieldType(parameter.type),
				...(parameter.optional ? { isOptional: true } : {}),
			})),
			{ name: field.objective, type: { name: "string" } },
			{ name: field.current, type: { name: "code" } },
		],
		outputs: [{
			name: field.output,
			description: `A complete replacement body for ${request.target.signature}`,
			type: { name: "code" },
		}],
	};
}

function trainingExamples(request: OptimizeRequest): RewriteInput[] {
	const examples: RewriteInput[] = [];
	for (const evaluation of request.evaluations) {
		const args = argsFromContent(evaluation.test?.input) ?? argsFromMessages(evaluation.result.input);
		const expected = expectedOutput(evaluation);
		if (args && expected !== undefined) examples.push(example(request, args, expected));
	}
	for (const record of request.records) {
		if (!record.succeeded) continue;
		const input = record.trace.messages.find((message) => message.role === "user");
		const output = [...record.trace.messages].reverse().find((message) => message.role === "assistant");
		const args = argsFromContent(input?.content);
		const expected = contentText(output?.content);
		if (args && expected !== undefined) examples.push(example(request, args, expected));
	}
	return deduplicate(examples);
}

function expectedOutput(evaluation: OptimizeRequest["evaluations"][number]): string | undefined {
	for (const assertion of evaluation.test?.assert ?? []) {
		if (assertion && typeof assertion === "object" && "type" in assertion && assertion.type === "equals" && "value" in assertion) {
			return outputText(assertion.value);
		}
	}
	return evaluation.result.executionStatus === "ok" ? evaluation.result.output : undefined;
}

function example(request: OptimizeRequest, args: readonly unknown[], expected: string): RewriteInput {
	const fields = Object.fromEntries(
		parameterFields(request).map(({ parameter, name }, index) => [name, inputValue(args[index], parameter.type)]),
	);
	return {
		...fields,
		[field.objective]: request.objective,
		[field.current]: request.target.implementation,
		[field.output]: request.target.implementation,
		[field.args]: JSON.stringify(args),
		[field.expected]: expected,
	};
}

function parameterFields(request: OptimizeRequest): Array<{
	readonly parameter: OptimizeRequest["target"]["parameters"][number];
	readonly name: string;
}> {
	const used = new Set<string>();
	return request.target.parameters.map((parameter, index) => {
		const words = parameter.name.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
		const suffix = words.map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join("") || `Arg${index + 1}`;
		let name = `methodArgument${suffix}`.slice(0, 46);
		while (used.has(name)) name = `${name.slice(0, 44)}${index + 1}`;
		used.add(name);
		return { parameter, name };
	});
}

async function scoreImplementation(
	request: OptimizeRequest,
	prediction: RewriteOutput,
	exampleValue: Record<string, unknown>,
	timeout = 5_000,
	signal?: AbortSignal,
): Promise<number> {
	if (!prediction?.[field.output]?.trim()) return 0;
	const args = JSON.parse(String(exampleValue[field.args] ?? "[]")) as unknown[];
	try {
		const actual = await executeImplementation(request.target, prediction[field.output], args, {
			timeoutMs: timeout,
			...(signal === undefined ? {} : { signal }),
		});
		return outputText(actual) === String(exampleValue[field.expected] ?? "") ? 1 : 0;
	} catch {
		return 0;
	}
}

async function service(value: Service | undefined, context: EngineContext): Promise<AxAIService> {
	if (value === undefined) return defaultAI(context);
	return typeof value === "function" ? value(context) : value;
}

async function defaultAI(context: EngineContext): Promise<AxAIService> {
	const apiKey = await context.secrets?.get("OPENAI_API_KEY", context.signal) ??
		process.env["OPENAI_API_KEY"] ?? process.env["OPENAI_APIKEY"];
	if (!apiKey) {
		throw new Error("default optimizer requires OPENAI_API_KEY or a custom TrainingSettings.engine");
	}
	return ai({ name: "openai", apiKey });
}

function fieldType(type: string): NonNullable<AxField["type"]> {
	const normalized = type.replace(/\s*\|\s*(undefined|null)/g, "").trim();
	const isArray = normalized.endsWith("[]") || /^Array<.+>$/.test(normalized);
	const base = normalized.replace(/\[]$/, "").replace(/^Array<(.+)>$/, "$1");
	const name = base === "string" ? "string" : base === "number" ? "number" : base === "boolean" ? "boolean" : "json";
	return { name, ...(isArray ? { isArray: true } : {}) };
}

function argsFromMessages(messages: OptimizeRequest["evaluations"][number]["result"]["input"]): unknown[] | undefined {
	const message = messages?.find((item) => item.role === "user") ?? messages?.[0];
	return argsFromContent(message?.content);
}

function argsFromContent(content: unknown): unknown[] | undefined {
	const text = contentText(content);
	if (text === undefined) return undefined;
	try {
		const parsed = JSON.parse(text) as unknown;
		return Array.isArray(parsed) ? parsed : [parsed];
	} catch {
		return [text];
	}
}

function contentText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((part) => typeof part === "string" ? part :
			part && typeof part === "object" && "text" in part ? String(part.text) : "").join("");
	}
	return content === undefined ? undefined : JSON.stringify(content);
}

function inputValue(value: unknown, type: string): unknown {
	if (type.includes("string")) return typeof value === "string" ? value : JSON.stringify(value);
	if (type.includes("number")) return Number(value);
	if (type.includes("boolean")) return Boolean(value);
	return value ?? null;
}

function publicInput(exampleValue: Record<string, AxFieldValue>): RewriteInput {
	return Object.fromEntries(Object.entries(exampleValue).filter(([key]) => key !== field.args && key !== field.expected && key !== field.output)) as RewriteInput;
}

function outputText(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

function deduplicate(examples: RewriteInput[]): RewriteInput[] {
	const seen = new Set<string>();
	return examples.filter((item) => {
		const key = String(item[field.args]);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
