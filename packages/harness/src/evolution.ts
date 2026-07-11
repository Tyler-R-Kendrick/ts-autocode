import {
	Dataset,
	GEPA,
	Program,
	requestContext,
	type GEPAOptions,
	type MetricFunction,
	type Prompt,
} from "gepa-rpc";

export interface AgentEvolutionExample {
	readonly input: unknown;
	readonly expected?: unknown;
}

export interface AgentEvolutionScore {
	readonly score: number;
	readonly feedback?: string;
}

export interface AgentEvolutionSettings {
	readonly examples: readonly AgentEvolutionExample[];
	readonly validation?: readonly AgentEvolutionExample[];
	readonly evaluate: (
		example: AgentEvolutionExample,
		output: unknown,
	) => number | AgentEvolutionScore | Promise<number | AgentEvolutionScore>;
}

export type GepaSettings = GEPAOptions;

export interface EvolutionComponent {
	readonly name: string;
	readonly seed: string;
	readonly settings: AgentEvolutionSettings;
	readonly run: (input: unknown, systemPrompt: string) => Promise<unknown>;
}

export async function evolvePrompts(
	components: readonly EvolutionComponent[],
	options: GepaSettings = {},
): Promise<Readonly<Record<string, string>>> {
	if (components.length === 0) return Object.freeze({});
	const names = new Set<string>();
	for (const component of components) {
		if (!component.name.trim()) throw new TypeError("GEPA component name must be non-empty");
		if (names.has(component.name)) throw new TypeError(`duplicate GEPA component: ${component.name}`);
		if (component.settings.examples.length === 0) {
			throw new TypeError(`${component.name} evolution requires at least one example`);
		}
		names.add(component.name);
	}
	const prompts = Object.fromEntries(components.map(({ name, seed }): [string, Prompt] => [
		name,
		{ name, systemPrompt: seed, _isPrompt: true },
	]));
	const byName = new Map(components.map((component) => [component.name, component]));
	const program = new Program(prompts, async ({ role, input }: { role: string; input: unknown }) => {
		const component = byName.get(role);
		const prompt = prompts[role];
		if (!component || !prompt) throw new Error(`unknown evolution role: ${role}`);
		const output = await component.run(input, prompt.systemPrompt);
		requestContext.getStore()?.trace.push({ predictor: role, input, output });
		return output;
	});
	const metric: MetricFunction = async (example, prediction) => {
		const component = byName.get(String(example.role));
		if (!component) throw new Error(`unknown evolution role: ${String(example.role)}`);
		const evaluated = await component.settings.evaluate(toExample(example), prediction.output);
		const score = typeof evaluated === "number" ? evaluated : evaluated.score;
		if (!Number.isFinite(score) || score < 0 || score > 1) {
			throw new RangeError(`${component.name} evolution score must be between 0 and 1`);
		}
		return typeof evaluated === "number" ? score : { score, ...(evaluated.feedback === undefined ? {} : { feedback: evaluated.feedback }) };
	};
	const optimized = await new GEPA(options).compile(
		program,
		metric,
		dataset(components, false),
		dataset(components, true),
	);
	return Object.freeze(Object.fromEntries(
		Object.entries(optimized._predictors).map(([name, prompt]) => [name, prompt.systemPrompt]),
	));
}

function dataset(components: readonly EvolutionComponent[], validation: boolean): Dataset {
	const examples = components.flatMap(({ name, settings }) =>
		(validation ? settings.validation ?? settings.examples : settings.examples).map((example) => ({
			role: name,
			input: example.input,
			...(example.expected === undefined ? {} : { expected: example.expected }),
		})));
	if (examples.length === 0) throw new TypeError("GEPA evolution requires at least one example");
	return new Dataset(examples, ["role", "input"]);
}

function toExample(example: Record<string, unknown>): AgentEvolutionExample {
	return {
		input: example.input,
		...(example.expected === undefined ? {} : { expected: example.expected }),
	};
}
