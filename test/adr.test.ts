import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { documentationFiles, readDoc } from "./support/docs.js";

import {
	createTrainingRuntime,
	directExecutor,
	instrumentTrainable,
	trainable,
	training,
	wrapTrainable,
} from "../src/index.js";

// Decisions the maintainer has made at the ADR level, pinned so they cannot
// be undone as a convenience. Each entry states the decision, refuses the
// rejected spelling at COMPILE time via @ts-expect-error -- if the surface
// ever admits it again, the suppression becomes unused and `npm run
// typecheck` fails -- and shows the accepted spellings still work.
// AGENTS.md states these rules for anyone (or anything) working here.

describe("ADR: trainable identity is never a plain string", () => {
	it("a string identity does not compile, and does not run", async () => {
		await expect(
			// @ts-expect-error -- rejected by ADR: identity is a symbol key, never a string.
			training.records("Router.route"),
		).rejects.toThrow("must be a symbol or TrainableToken");
	});

	// The intended design, end to end: the application owns a unique symbol,
	// `@trainable(symbol)` keys the code with it, and `train(symbol)` is plain
	// symbol-key indexing. The durable id the machinery needs is derived from
	// the declaration -- the user types no name anywhere.
	it("a unique symbol declared by the app keys the trainable end to end", async () => {
		const route: unique symbol = Symbol("route");
		class Router {
			route(input: string): string {
				"use training";
				return input;
			}
		}
		applyMethodDecorator(Router, "route", trainable(route));

		const directory = await mkdtemp(join(tmpdir(), "ts-autocode-adr-"));
		const artifact = join(directory, "router.ts");
		await writeFile(artifact, `class Router {
  route(input: string): string {
    "use training";
    return input;
  }
}\n`);
		const runtime = createTrainingRuntime({
			engine: () => "return input.toUpperCase();",
			executor: directExecutor,
			source: { files: [artifact] },
			tracing: { enabled: false },
		});

		const run = await runtime.train(route, {
			cases: [["abc", "ABC"]],
			evaluation: { outputDir: join(directory, "agentv") },
			rounds: { max: 1 },
		});

		expect(run.outcome).toBe("ready");
		expect(run.final.candidate.trainableId).toBe("Router.route");
		expect(await runtime.records(route)).toEqual([]);
	});

	it("one symbol keys one trainable; rebinding is refused", () => {
		const shared: unique symbol = Symbol("shared");
		class First { one(input: string): string { "use training"; return input; } }
		class Second { two(input: string): string { "use training"; return input; } }
		applyMethodDecorator(First, "one", trainable(shared));
		expect(() => applyMethodDecorator(Second, "two", trainable(shared)))
			.toThrow("already registered");
	});

	it("marked callables remain accepted identities", async () => {
		const marked = wrapTrainable((input: string): string => input, "Adr.byFunction");
		expect(await training.records(marked)).toEqual([]);

		class Plain { route(input: string): string { "use training"; return input; } }
		instrumentTrainable(Plain, "route", "Adr.instrumented");
		expect(await training.records(Plain.prototype.route)).toEqual([]);

		await expect(training.records((input: string) => input)).rejects.toThrow("is not marked trainable");
	});

	// The declaration-site string is machinery's business, never a pattern the
	// docs teach. A snippet calling defineTrainable( is a hard failure.
	it("no documentation snippet teaches defineTrainable(...)", () => {
		// Discovered, not listed: the list this replaced left out AGENTS.md --
		// the document that states this very ADR and carries the snippet
		// demonstrating it -- so the file defining the rule was exempt from the
		// check enforcing it.
		const offenders = documentationFiles()
			.filter((doc) => snippets(readDoc(doc)).some((code) => code.includes("defineTrainable(")));
		expect(offenders).toEqual([]);
	});

	it("no example calls defineTrainable(...) either", async () => {
		// Examples are the other place an application copies from. The review
		// that added this found examples/optimize.ts still teaching the banned
		// pattern -- it escaped the snippet scan because it is a .ts file.
		const repoRoot = fileURLToPath(new URL("..", import.meta.url));
		const { readdirSync } = await import("node:fs");
		const offenders = readdirSync(join(repoRoot, "examples"))
			.filter((name) => name.endsWith(".ts"))
			.filter((name) => readFileSync(join(repoRoot, "examples", name), "utf8").includes("defineTrainable("));
		expect(offenders).toEqual([]);
	});
});

function snippets(markdown: string): readonly string[] {
	const blocks: string[] = [];
	const lines = markdown.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		if (!/^\s*```ts$/.test(lines[index] ?? "")) continue;
		const block: string[] = [];
		for (index += 1; index < lines.length && (lines[index] ?? "").trim() !== "```"; index += 1) {
			block.push(lines[index] ?? "");
		}
		blocks.push(block.join("\n"));
	}
	return blocks;
}

function applyMethodDecorator<Class extends abstract new (...args: never[]) => object>(
	constructor: Class,
	name: string,
	decorator: ReturnType<typeof trainable>,
): void {
	const prototype = constructor.prototype as Record<string, unknown>;
	const method = prototype[name] as (this: unknown, ...args: unknown[]) => unknown;
	const initializers: Array<(this: object) => void> = [];
	const replacement = decorator(method, {
		kind: "method",
		name,
		static: false,
		private: false,
		access: {
			has: (value: unknown) => name in (value as object),
			get: (value: unknown) => (value as Record<string, unknown>)[name] as (...args: unknown[]) => unknown,
		},
		addInitializer(initializer: (this: object) => void) {
			initializers.push(initializer);
		},
		metadata: undefined,
	} as unknown as ClassMethodDecoratorContext);
	Object.defineProperty(prototype, name, { value: replacement, configurable: true, writable: true });
	for (const initializer of initializers) initializer.call(Object.create(constructor.prototype) as object);
}
