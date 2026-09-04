import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineTrainable, type BoundEvaluation, type TrainingRecord } from "../src/index.js";
import { apiKeyNamesFor, createAxEngine } from "../src/providers/ax.js";
import { discoverInSource } from "ts-autocode-training";

const mocks = vi.hoisted(() => ({
	ax: vi.fn(),
	optimize: vi.fn(),
	applyOptimization: vi.fn(),
	forward: vi.fn(),
	ai: vi.fn(),
}));

vi.mock("@ax-llm/ax", async (importOriginal) => ({
	...await importOriginal<typeof import("@ax-llm/ax")>(),
	ai: mocks.ai,
	ax: mocks.ax,
	optimize: mocks.optimize,
}));

const source = `class Router {
  route(input: string): string {
    "use training";
    return input;
  }
}`;
const target = discoverInSource(source, "src/router.ts")[0]!;
const token = defineTrainable("Router.route");
const evaluations: BoundEvaluation[] = [{
	trainableId: token.id,
	test: { id: "uppercase", input: "hello", assert: [{ type: "equals", value: "HELLO" }] },
	result: {
		input: [{ role: "user", content: '["hello"]' }],
		output: "hello",
		executionStatus: "quality_failure",
	} as never,
}];

describe("default Ax engine", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.ax.mockReturnValue({ applyOptimization: mocks.applyOptimization, forward: mocks.forward });
		mocks.forward.mockResolvedValue({ optimizedMethodImplementation: "return input.toUpperCase();" });
		mocks.ai.mockReturnValue({});
		mocks.optimize.mockImplementation(async (_program, examples, metric) => {
			expect(await metric({ prediction: { optimizedMethodImplementation: "return input.toUpperCase();" }, example: examples[0] }))
				.toBe(1);
			return {
				bestScore: 1,
				optimizedProgram: { optimizerType: "GEPA", converged: true, totalRounds: 2 },
			};
		});
	});
	afterEach(() => vi.unstubAllEnvs());

	it("derives the Ax program and executable metric from the method signature", async () => {
		const engine = createAxEngine({ studentAI: {} as never });
		const candidate = await engine.optimize(
			{ trainableId: token.id, objective: "uppercase the result", target, records: [], evaluations },
			{ variables: {} },
		);

		const signature = mocks.ax.mock.calls[0]?.[0] as {
			description: string;
			inputs: Array<{ name: string; description?: string }>;
		};
		expect(signature.description).toContain("route(input: string): string");
		expect(signature.inputs.map(({ name }) => name)).toEqual([
			"methodArgumentInput",
			"trainingObjective",
			"currentMethodImplementation",
		]);
		expect(signature.inputs[0]?.description).toBe("input: string");
		expect(mocks.optimize).toHaveBeenCalledOnce();
		expect(engine.id).toBe("@ax-llm/ax");
		expect(candidate).toMatchObject({ implementation: "return input.toUpperCase();" });
	});

	it("uses standard environment credentials without provider-specific root settings", async () => {
		vi.stubEnv("OPENAI_API_KEY", "test-key");
		const engine = createAxEngine();
		await engine.optimize(
			{ trainableId: token.id, objective: "improve", target, records: [], evaluations },
			{ variables: {} },
		);
		expect(mocks.ai).toHaveBeenCalledWith({ name: "openai", apiKey: "test-key" });
	});
});

/** The same optimize request the suite above uses, as a helper the model
 * selection tests can reuse. */
function request() {
	return { trainableId: token.id, objective: "improve", target, records: [], evaluations };
}

describe("model selection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.ax.mockReturnValue({
			applyOptimization: mocks.applyOptimization,
			forward: mocks.forward,
		});
		mocks.optimize.mockResolvedValue({ optimizedProgram: {} });
		mocks.forward.mockResolvedValue({ optimizedMethodImplementation: "return input;" });
	});

	afterEach(() => vi.unstubAllEnvs());

	// Choosing a model used to require constructing a whole replacement engine
	// via the barely-documented ts-autocode/ax subpath. It is now a setting.
	it("builds the service from a provider-neutral selection", async () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-key");
		const engine = createAxEngine();
		await engine.optimize(request(), {
			variables: {},
			model: { provider: "anthropic", name: "claude-sonnet-4-5" },
		}).catch(() => undefined);
		expect(mocks.ai).toHaveBeenCalledWith({
			name: "anthropic",
			apiKey: "anthropic-key",
			config: { model: "claude-sonnet-4-5" },
		});
	});

	it("prefers an explicit apiKey over the environment", async () => {
		vi.stubEnv("OPENAI_API_KEY", "from-env");
		const engine = createAxEngine();
		await engine.optimize(request(), {
			variables: {},
			model: { apiKey: "from-settings" },
		}).catch(() => undefined);
		expect(mocks.ai).toHaveBeenCalledWith({ name: "openai", apiKey: "from-settings" });
	});

	it("resolves a teacher model when one is selected", async () => {
		vi.stubEnv("OPENAI_API_KEY", "student-key");
		vi.stubEnv("ANTHROPIC_API_KEY", "teacher-key");
		const engine = createAxEngine();
		await engine.optimize(request(), {
			variables: {},
			model: { teacher: { provider: "anthropic" } },
		}).catch(() => undefined);
		expect(mocks.ai).toHaveBeenCalledWith({ name: "anthropic", apiKey: "teacher-key" });
	});

	it("names the provider's own key when it is missing", async () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "");
		const engine = createAxEngine();
		await expect(engine.optimize(request(), {
			variables: {},
			model: { provider: "anthropic" },
		})).rejects.toThrow("ANTHROPIC_API_KEY");
	});

	it("knows the conventional key name for an unlisted provider", () => {
		expect(apiKeyNamesFor("anthropic")).toEqual(["ANTHROPIC_API_KEY"]);
		expect(apiKeyNamesFor("some-new-provider")).toEqual(["SOME_NEW_PROVIDER_API_KEY"]);
	});

	// The provider/name descriptor is sugar over Ax's registry. The library is
	// responsible for no provider list: a user-built service -- any client with
	// a chat method -- passes straight through, keys and endpoints included.
	it("uses a supplied service directly, consulting no provider or key", async () => {
		const supplied = { chat: vi.fn() };
		const engine = createAxEngine();
		await engine.optimize(request(), {
			variables: {},
			model: { service: supplied },
		}).catch(() => undefined);
		expect(mocks.ai).not.toHaveBeenCalled();
		expect(mocks.optimize.mock.calls[0]?.[3]).toMatchObject({ studentAI: supplied });
	});

	it("accepts a factory for the supplied service and hands it the context", async () => {
		const supplied = { chat: vi.fn() };
		const factory = vi.fn(() => supplied);
		const engine = createAxEngine();
		await engine.optimize(request(), {
			variables: {},
			model: { service: factory },
		}).catch(() => undefined);
		expect(factory).toHaveBeenCalledWith(expect.objectContaining({ variables: {} }));
		expect(mocks.optimize.mock.calls[0]?.[3]).toMatchObject({ studentAI: supplied });
	});

	it("uses a supplied teacher service alongside a descriptor-built student", async () => {
		vi.stubEnv("OPENAI_API_KEY", "student-key");
		const teacher = { chat: vi.fn() };
		const engine = createAxEngine();
		await engine.optimize(request(), {
			variables: {},
			model: { teacher: { service: teacher } },
		}).catch(() => undefined);
		expect(mocks.optimize.mock.calls[0]?.[3]).toMatchObject({ teacherAI: teacher });
	});

	it("rejects a value that is not a service, naming the setting and the shape", async () => {
		const engine = createAxEngine();
		await expect(engine.optimize(request(), {
			variables: {},
			model: { service: { notAChatClient: true } },
		})).rejects.toThrow("model.service must be an AxAIService");
	});
});

// ---------------------------------------------------------------- examples
//
// What the engine hands Ax to optimize against is the whole substance of the
// default engine: everything else is provider plumbing. The suites above only
// ever pass one AgentV evaluation, so the branch that turns *captured traffic*
// into examples -- the zero-config path the README leads with -- was never
// executed, and neither was any of the content decoding underneath it.

function trace(messages: ReadonlyArray<{ role: string; content: unknown }>): TrainingRecord["trace"] {
	return { messages } as unknown as TrainingRecord["trace"];
}

function captured(overrides: Partial<TrainingRecord> = {}): TrainingRecord {
	return {
		id: "record-1",
		runId: "run-1",
		trainableId: token.id,
		method: "route",
		succeeded: true,
		recordedAt: new Date(0).toISOString(),
		trace: trace([
			{ role: "user", content: '["hello"]' },
			{ role: "assistant", content: "HELLO" },
		]),
		...overrides,
	};
}

/** The examples the engine handed the optimizer for a given request. */
async function examplesFor(request: Parameters<ReturnType<typeof createAxEngine>["optimize"]>[0]) {
	const engine = createAxEngine({ studentAI: {} as never });
	await engine.optimize(request, { variables: {} }).catch(() => undefined);
	return (mocks.optimize.mock.calls[0]?.[1] ?? []) as Array<Record<string, unknown>>;
}

describe("examples the engine optimizes against", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.ax.mockReturnValue({ applyOptimization: mocks.applyOptimization, forward: mocks.forward });
		mocks.forward.mockResolvedValue({ optimizedMethodImplementation: "return input.toUpperCase();" });
		mocks.optimize.mockResolvedValue({ optimizedProgram: {} });
	});

	it("turns a successful captured call into an example of its arguments and result", async () => {
		const examples = await examplesFor({
			trainableId: token.id, objective: "improve", target, records: [captured()], evaluations: [],
		});
		expect(examples).toHaveLength(1);
		expect(examples[0]).toMatchObject({
			methodArgumentInput: "hello",
			trainingArgumentsJson: '["hello"]',
			expectedMethodOutput: "HELLO",
			trainingObjective: "improve",
		});
	});

	it("skips a captured call that failed, which demonstrates nothing to reproduce", async () => {
		await expect(examplesFor({
			trainableId: token.id,
			objective: "improve",
			target,
			records: [captured({ succeeded: false })],
			evaluations: [],
		})).resolves.toEqual([]);
	});

	it("skips a capture with no assistant turn to learn an expected output from", async () => {
		await expect(examplesFor({
			trainableId: token.id,
			objective: "improve",
			target,
			records: [captured({ trace: trace([{ role: "user", content: '["hello"]' }]) })],
			evaluations: [],
		})).resolves.toEqual([]);
	});

	it("learns from the last assistant turn, not the first", async () => {
		const examples = await examplesFor({
			trainableId: token.id,
			objective: "improve",
			target,
			records: [captured({
				trace: trace([
					{ role: "user", content: '["hello"]' },
					{ role: "assistant", content: "stale" },
					{ role: "assistant", content: "HELLO" },
				]),
			})],
			evaluations: [],
		});
		expect(examples[0]).toMatchObject({ expectedMethodOutput: "HELLO" });
	});

	it("de-duplicates captures of the same arguments, however often they were served", async () => {
		const examples = await examplesFor({
			trainableId: token.id,
			objective: "improve",
			target,
			records: [captured(), captured({ id: "record-2" }), captured({ id: "record-3" })],
			evaluations: [],
		});
		expect(examples).toHaveLength(1);
	});

	it("refuses to optimize with nothing to learn from, naming the trainable", async () => {
		const engine = createAxEngine({ studentAI: {} as never });
		await expect(engine.optimize(
			{ trainableId: token.id, objective: "improve", target, records: [], evaluations: [] },
			{ variables: {} },
		)).rejects.toThrow(token.id);
		expect(mocks.optimize).not.toHaveBeenCalled();
	});

	describe("decoding what a trace carries as content", () => {
		it.each([
			["a JSON array, as the arguments themselves", '["hello"]', "hello"],
			["a bare JSON value, as a single argument", '"hello"', "hello"],
			["text that is not JSON, as one string argument", "hello", "hello"],
		])("reads %s", async (_label, content, expected) => {
			const examples = await examplesFor({
				trainableId: token.id,
				objective: "improve",
				target,
				records: [captured({ trace: trace([{ role: "user", content }, { role: "assistant", content: "HELLO" }]) })],
				evaluations: [],
			});
			expect(examples[0]).toMatchObject({ methodArgumentInput: expected });
		});

		it("joins the text parts of a multi-part content block", async () => {
			const examples = await examplesFor({
				trainableId: token.id,
				objective: "improve",
				target,
				records: [captured({
					trace: trace([
						{ role: "user", content: ['["hel', { text: 'lo"]' }] },
						{ role: "assistant", content: [{ text: "HEL" }, "LO"] },
					]),
				})],
				evaluations: [],
			});
			expect(examples[0]).toMatchObject({ methodArgumentInput: "hello", expectedMethodOutput: "HELLO" });
		});

		it("serializes a structured content block rather than dropping it", async () => {
			const examples = await examplesFor({
				trainableId: token.id,
				objective: "improve",
				target,
				records: [captured({
					trace: trace([
						{ role: "user", content: { note: "not text" } },
						{ role: "assistant", content: "HELLO" },
					]),
				})],
				evaluations: [],
			});
			expect(examples[0]).toMatchObject({ methodArgumentInput: '{"note":"not text"}' });
		});
	});

	describe("falling back to an evaluation's own result", () => {
		it("uses the recorded output when a test carries no `equals` assertion", async () => {
			const examples = await examplesFor({
				trainableId: token.id,
				objective: "improve",
				target,
				records: [],
				evaluations: [{
					trainableId: token.id,
					test: { id: "t", input: '["hello"]', assert: [{ type: "contains", value: "H" }] },
					result: { input: [{ role: "user", content: '["hello"]' }], output: "HELLO", executionStatus: "ok" },
				} as unknown as BoundEvaluation],
			});
			expect(examples[0]).toMatchObject({ expectedMethodOutput: "HELLO" });
		});

		it("skips an evaluation whose run did not execute cleanly and asserted nothing", async () => {
			await expect(examplesFor({
				trainableId: token.id,
				objective: "improve",
				target,
				records: [],
				evaluations: [{
					trainableId: token.id,
					test: { id: "t", input: '["hello"]', assert: [] },
					result: { input: [{ role: "user", content: '["hello"]' }], output: "HELLO", executionStatus: "error" },
				} as unknown as BoundEvaluation],
			})).resolves.toEqual([]);
		});

		it("reads the arguments from the run's own messages when the test has no input", async () => {
			const examples = await examplesFor({
				trainableId: token.id,
				objective: "improve",
				target,
				records: [],
				evaluations: [{
					trainableId: token.id,
					result: { input: [{ role: "user", content: '["hello"]' }], output: "HELLO", executionStatus: "ok" },
				} as unknown as BoundEvaluation],
			});
			expect(examples[0]).toMatchObject({ methodArgumentInput: "hello" });
		});

		it("falls back to the first message when no turn is marked as the user's", async () => {
			const examples = await examplesFor({
				trainableId: token.id,
				objective: "improve",
				target,
				records: [],
				evaluations: [{
					trainableId: token.id,
					result: { input: [{ role: "system", content: '["hello"]' }], output: "HELLO", executionStatus: "ok" },
				} as unknown as BoundEvaluation],
			});
			expect(examples[0]).toMatchObject({ methodArgumentInput: "hello" });
		});
	});
});

// ------------------------------------------------------------------ metric
//
// The metric is what the optimizer actually optimizes: it runs each candidate
// body and scores it against what the captured or evaluated call produced. It
// was only ever asserted through one inline expectation on the happy path, so
// none of the ways a candidate fails to earn a point were checked -- and a
// metric that scores everything 1 optimizes nothing.

/** The scoring function the engine handed the optimizer for this request. */
async function metricFor(records: TrainingRecord[]): Promise<
	(input: { prediction: unknown; example: unknown }) => Promise<number>
> {
	let captured: ((input: { prediction: unknown; example: unknown }) => Promise<number>) | undefined;
	let example: unknown;
	mocks.optimize.mockImplementation(async (_program, examples: unknown[], metric) => {
		captured = metric as typeof captured;
		example = examples[0];
		return { optimizedProgram: {} };
	});
	const engine = createAxEngine({ studentAI: {} as never });
	await engine.optimize(
		{ trainableId: token.id, objective: "uppercase", target, records, evaluations: [] },
		{ variables: {} },
	).catch(() => undefined);
	if (!captured) throw new Error("the engine never handed the optimizer a metric");
	const metric = captured;
	return (input) => metric({ ...input, example: input.example ?? example });
}

describe("the metric the engine hands the optimizer", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.ax.mockReturnValue({ applyOptimization: mocks.applyOptimization, forward: mocks.forward });
		mocks.forward.mockResolvedValue({ optimizedMethodImplementation: "return input;" });
	});

	it("scores a candidate that reproduces the captured output", async () => {
		const score = await metricFor([captured()]);
		await expect(score({
			prediction: { optimizedMethodImplementation: "return input.toUpperCase();" },
			example: undefined,
		})).resolves.toBe(1);
	}, 30_000);

	it("scores a candidate whose output differs at zero", async () => {
		const score = await metricFor([captured()]);
		await expect(score({
			prediction: { optimizedMethodImplementation: "return input;" },
			example: undefined,
		})).resolves.toBe(0);
	}, 30_000);

	it.each([
		["an empty body", ""],
		["a body of only whitespace", "   \n\t"],
	])("scores %s at zero without running anything", async (_label, implementation) => {
		const score = await metricFor([captured()]);
		await expect(score({
			prediction: { optimizedMethodImplementation: implementation },
			example: undefined,
		})).resolves.toBe(0);
	}, 30_000);

	it("scores a missing prediction at zero rather than throwing inside the optimizer", async () => {
		const score = await metricFor([captured()]);
		await expect(score({ prediction: undefined, example: undefined })).resolves.toBe(0);
	}, 30_000);

	it("scores a candidate that throws at zero, leaving the round to continue", async () => {
		// A model returns code that does not run more often than code that runs
		// and is wrong. Letting that reject would abort the whole optimization.
		const score = await metricFor([captured()]);
		await expect(score({
			prediction: { optimizedMethodImplementation: 'throw new Error("boom");' },
			example: undefined,
		})).resolves.toBe(0);
	}, 30_000);
});

describe("typing example values from the method signature", () => {
	// `inputValue` coerces each captured argument to the type its parameter
	// declares, so Ax receives a number field as a number rather than as the
	// string the JSON trace round-tripped it through. Only the string arm ran.
	const typedSource = `class Router {
  page(index: number, deep: boolean, extra: Record<string, unknown>, tags: string[]): string {
    "use training";
    return String(index);
  }
}`;
	const typedTarget = discoverInSource(typedSource, "src/typed.ts")[0]!;
	const typedToken = defineTrainable("Router.page");

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.ax.mockReturnValue({ applyOptimization: mocks.applyOptimization, forward: mocks.forward });
		mocks.forward.mockResolvedValue({ optimizedMethodImplementation: "return String(index);" });
		mocks.optimize.mockResolvedValue({ optimizedProgram: {} });
	});

	it("coerces each argument to the type its parameter declares", async () => {
		const engine = createAxEngine({ studentAI: {} as never });
		await engine.optimize({
			trainableId: typedToken.id,
			objective: "improve",
			target: typedTarget,
			records: [captured({
				trainableId: typedToken.id,
				trace: trace([
					{ role: "user", content: '["7", "yes", {"a":1}, ["x","y"]]' },
					{ role: "assistant", content: "7" },
				]),
			})],
			evaluations: [],
		}, { variables: {} }).catch(() => undefined);

		const examples = (mocks.optimize.mock.calls[0]?.[1] ?? []) as Array<Record<string, unknown>>;
		expect(examples[0]).toMatchObject({
			methodArgumentIndex: 7,
			methodArgumentDeep: true,
			// Declared `json` and `string[]`, so they arrive as an object and an
			// array -- not as the JSON strings a second substring match produced.
			methodArgumentExtra: { a: 1 },
			methodArgumentTags: ["x", "y"],
		});
	});

	it("wraps a captured argument that is not an array where the signature declares one", async () => {
		const engine = createAxEngine({ studentAI: {} as never });
		await engine.optimize({
			trainableId: typedToken.id,
			objective: "improve",
			target: typedTarget,
			records: [captured({
				trainableId: typedToken.id,
				trace: trace([
					{ role: "user", content: '[1, true, {}, "solo"]' },
					{ role: "assistant", content: "1" },
				]),
			})],
			evaluations: [],
		}, { variables: {} }).catch(() => undefined);

		const examples = (mocks.optimize.mock.calls[0]?.[1] ?? []) as Array<Record<string, unknown>>;
		expect(examples[0]).toMatchObject({ methodArgumentTags: ["solo"] });
	});

	it("passes a missing argument as an empty array where one is declared", async () => {
		const engine = createAxEngine({ studentAI: {} as never });
		await engine.optimize({
			trainableId: typedToken.id,
			objective: "improve",
			target: typedTarget,
			records: [captured({
				trainableId: typedToken.id,
				trace: trace([{ role: "user", content: "[1]" }, { role: "assistant", content: "1" }]),
			})],
			evaluations: [],
		}, { variables: {} }).catch(() => undefined);

		const examples = (mocks.optimize.mock.calls[0]?.[1] ?? []) as Array<Record<string, unknown>>;
		expect(examples[0]).toMatchObject({ methodArgumentTags: [], methodArgumentExtra: null });
	});

	it("declares the Ax field type each parameter maps to", async () => {
		const engine = createAxEngine({ studentAI: {} as never });
		await engine.optimize({
			trainableId: typedToken.id,
			objective: "improve",
			target: typedTarget,
			records: [captured({ trainableId: typedToken.id })],
			evaluations: [],
		}, { variables: {} }).catch(() => undefined);

		const signature = mocks.ax.mock.calls[0]?.[0] as {
			inputs: Array<{ name: string; type?: { name: string; isArray?: boolean } }>;
		};
		expect(signature.inputs.slice(0, 4).map((field) => [field.name, field.type?.name, field.type?.isArray ?? false]))
			.toEqual([
				["methodArgumentIndex", "number", false],
				["methodArgumentDeep", "boolean", false],
				["methodArgumentExtra", "json", false],
				["methodArgumentTags", "string", true],
			]);
	});
});
