import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
	createTrainingRuntime,
	defineTrainable,
	directExecutor,
	type Training,
	type TrainingEngine,
	type TrainingEvent,
	type TrainingRun,
} from "../../src/index.js";


export interface ScenarioOptions {
	readonly name: string;
	readonly source?: string;
	readonly proposal?: string;
}

const defaultSource = `class Router {
	route(input: string): string {
		"use training";
		return input;
	}
}
`;

export { directExecutor };

export class Scenario {
	readonly events: TrainingEvent[] = [];
	readonly directory: string;
	readonly artifact: string;

	#source: string;
	#proposal: string;
	#training: Training | undefined;
	#run: TrainingRun | undefined;
	#activation: Awaited<ReturnType<TrainingRun["activate"]>> | undefined;
	#failure: unknown;
	#engine: TrainingEngine | undefined;
	#minTraces: number | undefined;
	#autoEvolve = false;

	constructor(options: ScenarioOptions) {
		this.directory = join("test/output/specs", options.name);
		this.artifact = join(this.directory, "router.ts");
		this.#source = options.source ?? defaultSource;
		this.#proposal = options.proposal ?? "return input.toUpperCase();";
	}


	async givenAMarkedModule(): Promise<this> {
		await rm(this.directory, { recursive: true, force: true });
		await mkdir(this.directory, { recursive: true });
		await writeFile(this.artifact, this.#source, "utf8");
		return this;
	}

	givenAnEngineThatProposes(implementation: string): this {
		this.#proposal = implementation;
		return this;
	}

	givenAnEngineThatFails(message: string): this {
		this.#engine = { id: "spec/failing", optimize: async () => { throw new Error(message); } };
		return this;
	}

	givenEvolutionIsOn(minTraces: number): this {
		this.#autoEvolve = true;
		this.#minTraces = minTraces;
		return this;
	}

	get training(): Training {
		this.#training ??= createTrainingRuntime({
			engine: this.#engine ?? { id: "spec/engine", optimize: async () => ({ implementation: this.#proposal }) },
			executor: directExecutor,
			source: { files: [this.artifact] },
			tracing: { enabled: false },
			onEvent: (event) => this.events.push(event),
			...(this.#autoEvolve
				? {
					evolution: {
						auto: true,
						minTraces: this.#minTraces ?? 1,
						evaluation: { outputDir: join(this.directory, "agentv-evolve") },
					},
				}
				: {}),
		});
		return this.#training;
	}


	whenTheApplicationCalls(...inputs: readonly string[]): this {
		for (const input of inputs) {
			this.training.capture(
				defineTrainable("Router.route"),
				"route",
				undefined,
				(value: string) => value,
				[input],
			);
		}
		return this;
	}

	async whenTrainedAgainst(cases: ReadonlyArray<readonly [string, string]>): Promise<this> {
		this.#failure = undefined;
		try {
			this.#run = await this.training.train({
				trainable: defineTrainable("Router.route").symbol,
				evaluation: {
					tests: cases.map(([input, expected], index) => ({
						id: `case-${index}`,
						input,
						assert: [{ type: "equals" as const, value: expected }],
					})),
					task: (value: string) => value.toUpperCase(),
					outputDir: join(this.directory, "agentv"),
				},
				rounds: { max: 1 },
			});
		} catch (error) {
			this.#failure = error;
		}
		return this;
	}

	async whenTrainedFromCapturedTraffic(minTraces: number): Promise<this> {
		this.#failure = undefined;
		try {
			this.#run = await this.training.train({
				trainable: defineTrainable("Router.route").symbol,
				minTraces,
				evaluation: { outputDir: join(this.directory, "agentv-live") },
				rounds: { max: 1 },
			});
		} catch (error) {
			this.#failure = error;
		}
		return this;
	}

	async whenActivated(): Promise<this> {
		this.#failure = undefined;
		try {
			this.#activation = await this.run.activate();
		} catch (error) {
			this.#failure = error;
		}
		return this;
	}

	async whenRolledBack(): Promise<this> {
		this.#failure = undefined;
		try {
			await this.activation.rollback();
		} catch (error) {
			this.#failure = error;
		}
		return this;
	}

	async whenTheFileIsEditedTo(replacement: string): Promise<this> {
		const current = await readFile(this.artifact, "utf8");
		await writeFile(this.artifact, current.replace("return input;", replacement), "utf8");
		return this;
	}

	async whenBackgroundWorkSettles(done: () => boolean, attempts = 60): Promise<this> {
		await this.training.flush();
		for (let attempt = 0; attempt < attempts && !done(); attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		return this;
	}


	get run(): TrainingRun {
		if (this.#run === undefined) throw new Error("no training run: the scenario never trained, or training threw");
		return this.#run;
	}

	get activation(): Awaited<ReturnType<TrainingRun["activate"]>> {
		if (this.#activation === undefined) throw new Error("no activation: the scenario never activated, or it threw");
		return this.#activation;
	}

	get failure(): unknown {
		return this.#failure;
	}

	async currentSource(): Promise<string> {
		return readFile(this.artifact, "utf8");
	}

	get originalSource(): string {
		return this.#source;
	}

	eventTypes(): readonly string[] {
		return this.events.map((event) => event.type);
	}
}

export async function given(options: ScenarioOptions): Promise<Scenario> {
	return new Scenario(options).givenAMarkedModule();
}
