import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { discoverInSource, discoverTrainables } from "../src/source.js";

describe("TypeScript trainable discovery", () => {
	it("uses the literal directive to discover the decorated method body and signature", () => {
		const source = `class Router {
  route(input: string, retries?: number): Promise<string> {
    "use training";
    return Promise.resolve(input.repeat(retries ?? 1));
  }
}`;
		const [target] = discoverInSource(source, "src/router.ts");

		expect(target).toMatchObject({
			id: "Router.route",
			artifactRef: "src/router.ts",
			className: "Router",
			methodName: "route",
			returnType: "Promise<string>",
		});
		expect(target?.signature).toBe("route(input: string, retries?: number): Promise<string>");
		expect(target?.parameters).toEqual([
			{ name: "input", declaration: "input: string", type: "string", optional: false },
			{ name: "retries", declaration: "retries?: number", type: "number", optional: true },
		]);
		expect(target?.implementation).toBe("return Promise.resolve(input.repeat(retries ?? 1));");
	});

	it("resolves decorator tokens without external source metadata", () => {
		const source = `const route = defineTrainable("router.route");
class Router {
  @trainable(route.symbol)
  route(input: string): string { return input; }
}`;
		const [target] = discoverInSource(source, "src/router.ts");

		expect(target?.id).toBe("router.route");
		expect(target?.implementation).toBe("return input;");
	});

	it("infers the id from the decorated class and method when the decorator has no argument", () => {
		const source = `class Router {
  @trainable()
  route(input: string): string { return input; }
}`;
		expect(discoverInSource(source, "src/router.ts")[0]?.id).toBe("Router.route");
	});

	it("resolves registered symbol identities and strips the library prefix", () => {
		const source = `class Router {
  @trainable(Symbol.for("ts-autocode.trainable:custom.route"))
  route(input: string): string { return input; }
}`;
		expect(discoverInSource(source, "src/router.ts")[0]?.id).toBe("custom.route");
	});

	it("resolves imported trainable tokens through the TypeScript program", async () => {
		const output = "test/output/source";
		await mkdir(output, { recursive: true });
		await writeFile(`${output}/tokens.ts`, `declare function defineTrainable(id: string): unknown;
export const route = defineTrainable("custom.route");`, "utf8");
		await writeFile(`${output}/router.ts`, `declare function trainable(token: unknown): MethodDecorator;
import { route } from "./tokens";
class Router {
  @trainable(route)
  route(input: string): string { return input; }
}`, "utf8");

		expect(discoverTrainables({ files: [`${output}/router.ts`] })[0]?.id).toBe("custom.route");
	});
});

describe("parameter types inferred from literal defaults", () => {
	// A defaulted parameter has no type annotation, and reporting it as
	// `unknown` reached the Ax field mapper as `json`, so the optimizer was
	// told a plainly numeric argument had an opaque shape. Found by the
	// characterization snapshot of the generated program signature.
	const declare = (parameters: string) => discoverInSource(`class Fixture {
	method(${parameters}): void {
		"use training";
	}
}`, "fixture.ts")[0]?.parameters ?? [];

	it.each([
		["retries = 2", "number"],
		["name = \"x\"", "string"],
		["flag = true", "boolean"],
		["flag = false", "boolean"],
		["offset = -1", "number"],
		["big = 1n", "bigint"],
		["tags = [\"a\", \"b\"]", "string[]"],
		["counts = [1, 2]", "number[]"],
	])("infers %s as %s", (declaration, expected) => {
		expect(declare(declaration)[0]?.type).toBe(expected);
	});

	it("prefers an explicit annotation over the initializer", () => {
		expect(declare("retries: 1 | 2 = 2")[0]?.type).toBe("1 | 2");
	});

	it("leaves a non-literal default unknown rather than guessing", () => {
		for (const declaration of ["value = compute()", "value = {}", "value = []", "mixed = [1, \"a\"]"]) {
			expect(declare(declaration)[0]?.type).toBe("unknown");
		}
	});

	it("still marks a defaulted parameter optional", () => {
		expect(declare("retries = 2")[0]?.optional).toBe(true);
	});

	it("leaves an undefaulted, unannotated parameter unknown", () => {
		expect(declare("value")[0]?.type).toBe("unknown");
	});
});

describe("offsets on source TypeScript could not fully parse", () => {
	// Error recovery synthesizes a body for an unterminated block whose `end`
	// can sit past EOF, so a truncated file produced a target claiming offsets
	// outside its own source. Found by fuzzing generated-then-damaged modules.
	const truncated = 'class Router {\n\troute(input: string): string {\n\t\t"use training";\n\t\t// } a brace in a comm';

	it("never reports offsets outside the source", () => {
		for (const target of discoverInSource(truncated, "truncated.ts")) {
			expect(target.bodyStart).toBeGreaterThanOrEqual(0);
			expect(target.bodyEnd).toBeLessThanOrEqual(truncated.length);
			expect(target.bodyStart).toBeLessThanOrEqual(target.bodyEnd);
		}
	});

	it("keeps the digest consistent with the clamped slice", () => {
		for (const target of discoverInSource(truncated, "truncated.ts")) {
			const raw = truncated.slice(target.bodyStart, target.bodyEnd);
			expect(raw.trim()).toBe(target.implementation);
		}
	});

	it("leaves offsets untouched for source that parses", () => {
		const valid = 'class Router {\n\troute(input: string): string {\n\t\t"use training";\n\t\treturn input;\n\t}\n}\n';
		const target = discoverInSource(valid, "valid.ts")[0]!;
		expect(valid.slice(target.bodyStart, target.bodyEnd).trim()).toBe("return input;");
	});
});
