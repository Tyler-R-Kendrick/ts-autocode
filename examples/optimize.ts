import type { EvalTestInput } from "@agentv/core";

// Imported by package name, exactly as a consumer would. The repo maps
// `ts-autocode` to `src/` for typechecking; a published install resolves the
// same specifier to `dist/`.
import { createTrainingRuntime, defineTrainable, type TrainingEngine } from "ts-autocode";

class Router {
	route(input: string): string {
		"use training";
		return input.includes("invoice") ? "billing" : "fallback";
	}
}

const tests = [
	{ id: "billing", input: "Where is my invoice?", assert: [{ type: "equals", value: "billing" }] },
	{ id: "fallback", input: "Reset my password", assert: [{ type: "equals", value: "fallback" }] },
] satisfies EvalTestInput[];

// The token's symbol binds these evals to the directive-marked method above.
// `npx ts-autocode discover` prints this id rather than making you guess it.
const route = defineTrainable("Router.route");

/** Runs the example. Pass an engine to run it offline — the default Ax engine
 * needs a provider key, which a CI typecheck must not require. */
export async function optimizeRouter(engine?: TrainingEngine) {
	const router = new Router();
	const training = createTrainingRuntime({
		source: { files: [import.meta.filename] },
		...(engine === undefined ? {} : { engine }),
	});
	return training.train({
		trainable: route.symbol,
		objective: "Keep billing routing correct and preserve the fallback",
		evaluation: {
			tests,
			task: (input) => router.route(input),
			workers: 2,
			outputDir: "examples/output",
		},
		rounds: { max: 2 },
		promotion: { minScore: 1 },
	});
}

// `node --experimental-strip-types examples/optimize.ts` runs it for real,
// against whatever `model` / OPENAI_API_KEY you have configured.
if (import.meta.filename === process.argv[1]) {
	const run = await optimizeRouter();
	const readiness = run.canActivate();
	console.log(run.outcome, readiness.ready ? "promotable" : readiness.failures);
}
