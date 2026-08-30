import { describe, expect, it } from "vitest";

import {
	applyCandidate,
	candidateDeclaration,
	commitRewrite,
	createRewriter,
	discoverInSource,
	emitInstrumentation,
	evaluatePromotionGate,
	revertRewrite,
	type CandidatePatch,
} from "../src/index.js";
import { generateDeclaredRegistrations, scanDeclaredTrainables } from "ts-autocode-grounding";
import { augmentSource } from "../src/register/hook.js";
import { run, usage } from "../src/cli.js";
import { verify, verifyJson } from "./support/verify.js";

// Characterization tests over everything this library *generates*. For a
// library whose product is rewritten source, the generated text is the product
// -- and a diff of it is the only review that shows what actually changed.
// Assertions like `toContain("return input")` say almost nothing about the
// emitted module; an approved file says all of it.
//
// These are deliberately not correctness tests. They pin current behavior so
// that an unintended change to it shows up in a pull request diff.

const routerSource = `class Router {
	route(input: string): string {
		"use training";
		return input.includes("invoice") ? "billing" : "fallback";
	}

	async enrich(id: string, deep?: boolean): Promise<string> {
		"use training";
		return \`\${id}:\${deep}\`;
	}
}

export function normalize(input: string): string {
	"use training";
	return input.trim();
}
`;

const target = discoverInSource(routerSource, "router.ts")[0]!;

function candidate(implementation: string): CandidatePatch {
	return { id: "cand-1", trainableId: target.id, engineId: "characterization", target, implementation };
}

describe("discovered source targets", () => {
	it("records the signature, parameters and offsets an engine will see", async () => {
		// This is the entire contract handed to an optimizer. A change to any
		// field silently changes every generated prompt.
		await verifyJson("source/discovered-targets", discoverInSource(routerSource, "router.ts"));
	});

	it("describes a decorated class the same way", async () => {
		const decorated = `import { defineTrainable, trainable } from "ts-autocode";

const route = defineTrainable("acme.route");

class Service {
	@trainable(route.symbol)
	handle(input: string, retries = 2): string {
		return input;
	}
}
`;
		await verifyJson("source/discovered-decorated", discoverInSource(decorated, "service.ts"));
	});
});

describe("emitted instrumentation", () => {
	it("appends a registration statement that binds no names", async () => {
		await verify("rewrite/emitted-instrumentation.ts", emitInstrumentation([
			{ id: "Router.route", methodName: "route", className: "Router" },
			{ id: "normalize", methodName: "normalize" },
		]));
	});

	it("rewrites a whole module append-only, leaving original lines untouched", async () => {
		const rewriter = createRewriter((source, path) =>
			discoverInSource(source, path).map((found) => ({
				id: found.id,
				methodName: found.methodName,
				...(found.className === undefined ? {} : { className: found.className }),
			})), "use training");
		await verify("rewrite/augmented-module.ts", rewriter(routerSource, "router.ts"));
	});

	it("produces the same module through the register hook", async () => {
		await verify("rewrite/register-hook-output.ts", augmentSource(routerSource, "router.ts"));
	});

	it("leaves an unmarked module byte-identical", () => {
		const plain = "export const value = 1;\n";
		expect(augmentSource(plain, "plain.ts")).toBe(plain);
	});
});

describe("candidate application", () => {
	it("wraps a proposed body in the synthetic declaration an executor runs", async () => {
		await verify("engine/candidate-declaration.ts",
			candidateDeclaration(target, "\treturn input.toUpperCase();"));
	});

	it("preserves the async signature for an async target", async () => {
		const asyncTarget = discoverInSource(routerSource, "router.ts")[1]!;
		await verify("engine/candidate-declaration-async.ts",
			candidateDeclaration(asyncTarget, "\treturn `${id}`;"));
	});

	it("rewrites only the marked body, keeping the directive and indentation", async () => {
		await verify("rewrite/applied-candidate.ts",
			applyCandidate(routerSource, candidate("\t\treturn input.toUpperCase();")));
	});

	it("round-trips exactly through revert", () => {
		const committed = commitRewrite(routerSource, candidate("\t\treturn input.toUpperCase();"));
		expect(revertRewrite(committed.source, committed.snapshot)).toBe(routerSource);
	});
});

describe("grounding codegen", () => {
	it("emits registration source for an ambient declaration", async () => {
		const [declared] = scanDeclaredTrainables(`@trainable
export declare class Program {
	@intent("Produce a greeting")
	@returns("Hello World! or Hello, <name>!")
	greet(
		@description("Optional person to greet")
		name?: string,
	): string;

	other(count: number): number;
}
`);
		await verify("grounding/declared-registrations.ts",
			generateDeclaredRegistrations(declared!));
	});
});

describe("promotion decisions", () => {
	it("reports the standard gate failures a rejected candidate collects", async () => {
		const decision = await evaluatePromotionGate({
			candidate: candidate("return input;"),
			evaluations: [],
			conformance: false,
		});
		await verifyJson("promotion/rejected-decision", decision);
	});

	it("reports a passing decision", async () => {
		const decision = await evaluatePromotionGate({
			candidate: candidate("return input;"),
			evaluations: [{
				trainableId: target.id,
				candidateId: "cand-1",
				result: { testId: "a", score: 1, executionStatus: "ok", output: "x" } as never,
			}],
			conformance: true,
		});
		await verifyJson("promotion/accepted-decision", decision);
	});
});

describe("command line output", () => {
	it("prints usage", async () => {
		await verify("cli/usage.txt", usage);
	});

	it("prints the discover table a user copies identities from", async () => {
		const { mkdir, writeFile } = await import("node:fs/promises");
		await mkdir("test/output/characterization", { recursive: true });
		await writeFile("test/output/characterization/router.ts", routerSource, "utf8");
		const result = await run(["discover", "--cwd", "test/output/characterization", "--file", "router.ts"]);
		await verify("cli/discover.txt", result.stdout);
	});

	it("prints the status table", async () => {
		const result = await run(["status", "--cwd", "test/output/characterization", "--file", "router.ts"]);
		await verify("cli/status.txt", result.stdout);
	});
});
