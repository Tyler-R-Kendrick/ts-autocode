import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineTrainable, type BoundEvaluation } from "../src/index.js";
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
