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
  @trainable(route)
  route(input: string): string { return input; }
}`;
		const [target] = discoverInSource(source, "src/router.ts");

		expect(target?.id).toBe("router.route");
		expect(target?.implementation).toBe("return input;");
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
