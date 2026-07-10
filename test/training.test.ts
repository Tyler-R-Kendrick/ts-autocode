import { describe, expect, it } from "vitest";

import {
	createMemoryTrainingStore,
	defineTrainable,
	findGeneratedRegion,
	trainable,
	useTraining,
	type CandidatePatch,
	type TrainingEngine,
} from "../src/index.js";
import { generatedRegionSource } from "./fixtures.js";

const source = generatedRegionSource(
	[{ id: "route", body: "  route(input: string) { return input; }" }],
	(content) => `export class Router {\n${content}\n}`,
);
const region = findGeneratedRegion(source, "route", { artifactRef: "src/router.ts" });

describe("trainable identity", () => {
	it("uses a durable id and stable symbol", () => {
		const first = defineTrainable("router.route");
		const second = defineTrainable("router.route");
		expect(first.id).toBe("router.route");
		expect(first.symbol).toBe(second.symbol);
	});
});

describe("trainable decorators", () => {
	it("supports the useTraining bound decorator and maps captures to token and region", async () => {
		const token = defineTrainable("router.route");
		const store = createMemoryTrainingStore();
		const training = useTraining({ store });

		class Router {
			route(input: string): string {
				return input.toUpperCase();
			}
		}
		applyMethodDecorator(Router, "route", training.trainable({ token, region }));

		expect(new Router().route("billing")).toBe("BILLING");
		await training.flush();
		const [record] = await training.records(token);
		expect(record).toMatchObject({ trainableId: token.id, method: "route", region, succeeded: true });
		expect(record?.trace.messages.map((message) => message.content)).toEqual([
			'["billing"]',
			"BILLING",
		]);
		expect(training.regions(token)).toEqual([region]);
	});

	it("supports the standalone decorator and captures async errors", async () => {
		const token = defineTrainable("router.fail");
		const training = useTraining({});

		class Router {
			async fail(): Promise<void> {
				throw new Error("boom");
			}
		}
		applyMethodDecorator(Router, "fail", trainable({ training, token, region }));

		await expect(new Router().fail()).rejects.toThrow("boom");
		await training.flush();
		const [record] = await training.records(token);
		expect(record?.succeeded).toBe(false);
		expect(record?.trace.errorCount).toBe(1);
	});
});

function applyMethodDecorator<Class extends abstract new (...args: never[]) => object>(
	constructor: Class,
	name: string,
	decorator: ReturnType<typeof trainable>,
): void {
	const prototype = constructor.prototype as Record<string, unknown>;
	const method = prototype[name] as (...args: unknown[]) => unknown;
	const replacement = decorator(method, {
		kind: "method",
		name,
		static: false,
		private: false,
		access: {
			has: (value: unknown) => name in (value as object),
			get: (value: unknown) => (value as Record<string, unknown>)[name] as (...args: unknown[]) => unknown,
		},
		addInitializer() {},
		metadata: undefined,
	} as unknown as ClassMethodDecoratorContext);
	Object.defineProperty(prototype, name, { value: replacement, configurable: true, writable: true });
}

describe("training execution", () => {
	it("runs independent optimization jobs concurrently", async () => {
		let active = 0;
		let maxActive = 0;
		const token = defineTrainable("router.route");
		const candidate = (id: string): CandidatePatch => ({
			id,
			trainableId: token.id,
			engineId: "parallel",
			edits: [{
				artifactRef: region.artifactRef,
				regionId: region.regionId,
				startOffset: region.startOffset,
				endOffset: region.endOffset,
				replacement: "return input;",
			}],
		});
		const engine: TrainingEngine = {
			id: "parallel",
			async optimize(request) {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 10));
				active -= 1;
				return candidate(request.objective);
			},
		};
		const training = useTraining({ engine, concurrency: 2 });
		const inputs = ["one", "two"].map((objective) => ({
			token,
			objective,
			artifacts: { [region.artifactRef]: source },
			regions: [region],
		}));

		await training.optimizeAll(inputs);
		expect(maxActive).toBe(2);
	});
});
