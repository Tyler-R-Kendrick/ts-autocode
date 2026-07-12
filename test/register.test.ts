import { describe, expect, it } from "vitest";

import { augmentSource } from "../src/register/hook.js";

describe("register source augmentation", () => {
	it("appends guarded instrumentation for directive-marked classes and functions", () => {
		const source = `export class Router {
  route(input) {
    "use training";
    return input;
  }
}
export function normalize(input) {
  "use training";
  return input;
}
`;
		const augmented = augmentSource(source, "/app/router.js");

		expect(augmented.startsWith(source)).toBe(true);
		expect(augmented).toContain('__tsAutocodeInstrument.method(Router, "route", "Router.route");');
		expect(augmented).toContain('normalize = __tsAutocodeInstrument.wrap(normalize, "normalize");');
		expect(augmented).toContain('globalThis[Symbol.for("ts-autocode.instrument")]');
	});

	it("returns sources without trainables unchanged, including on parse-adjacent content", () => {
		expect(augmentSource("export const x = 1;\n", "/app/x.js")).toBe("export const x = 1;\n");
		const mention = "// mentions use training in a comment only\nexport const y = 2;\n";
		expect(augmentSource(mention, "/app/y.js")).toBe(mention);
	});
});
