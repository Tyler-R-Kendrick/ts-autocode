import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { discoverInSource, isTsAutocodeError } from "../src/index.js";
import { augmentSource } from "../src/register/hook.js";
import { run } from "../src/cli.js";
import { scanDeclaredTrainables } from "ts-autocode-grounding";
import { commitRewrite, digest as rewriteDigest, revertRewrite } from "ts-autocode-rewrite";
import { evolutionEnabled } from "../src/evolve.js";
import { anyModule, damagedModule, markedModule } from "./support/sources.js";


const runs = 200;

const hostileSource = anyModule;

describe("source discovery", () => {
	it("never crashes on arbitrary text", () => {
		fc.assert(fc.property(fc.string({ maxLength: 400 }), (source) => {
			expect(() => discoverInSource(source, "fuzz.ts")).not.toThrow();
		}), { numRuns: runs });
	});

	it("never crashes on hostile fragments", () => {
		fc.assert(fc.property(hostileSource, (source) => {
			try {
				discoverInSource(source, "fuzz.ts");
			} catch (error) {
				expect(isTsAutocodeError(error)).toBe(true);
			}
		}), { numRuns: runs });
	});

	it("only ever reports targets whose offsets lie inside the source", () => {
		fc.assert(fc.property(hostileSource, (source) => {
			for (const target of safeDiscover(source)) {
				expect(target.bodyStart).toBeGreaterThanOrEqual(0);
				expect(target.bodyEnd).toBeLessThanOrEqual(source.length);
				expect(target.bodyStart).toBeLessThanOrEqual(target.bodyEnd);
			}
		}), { numRuns: runs });
	});

	it("relates the body slice, implementation and digest exactly as documented", () => {
		fc.assert(fc.property(hostileSource, (source) => {
			for (const target of safeDiscover(source)) {
				const raw = source.slice(target.bodyStart, target.bodyEnd);
				expect(raw.trim()).toBe(target.implementation);
				expect(rewriteDigest(raw)).toBe(target.bodyDigest);
			}
		}), { numRuns: runs });
	});

	it("produces targets a guarded rewrite accepts and can revert", () => {
		fc.assert(fc.property(markedModule, (source) => {
			for (const target of safeDiscover(source)) {
				const candidate = {
					id: "fuzz", trainableId: target.id, engineId: "fuzz", target,
					implementation: "return \"fuzzed\";",
				};
				const committed = commitRewrite(source, candidate);
				expect(committed.source).not.toBe(source);
				expect(revertRewrite(committed.source, committed.snapshot)).toBe(source);
			}
		}), { numRuns: 100 });
	});

	it("never reports an empty identity", () => {
		fc.assert(fc.property(hostileSource, (source) => {
			for (const target of safeDiscover(source)) {
				expect(target.id.trim().length).toBeGreaterThan(0);
			}
		}), { numRuns: runs });
	});
});

describe("the register load hook", () => {
	it("never throws, whatever the module contains", () => {
		fc.assert(fc.property(fc.string({ maxLength: 400 }), (source) => {
			expect(() => augmentSource(source, "fuzz.ts")).not.toThrow();
		}), { numRuns: runs });
	});

	it("is append-only: the original source is always a prefix of the result", () => {
		fc.assert(fc.property(hostileSource, (source) => {
			expect(augmentSource(source, "fuzz.ts").startsWith(source)).toBe(true);
		}), { numRuns: runs });
	});

	it("leaves a module without the marker byte-identical", () => {
		fc.assert(fc.property(fc.string({ maxLength: 400 }), (source) => {
			fc.pre(!source.includes("use training"));
			expect(augmentSource(source, "fuzz.ts")).toBe(source);
		}), { numRuns: runs });
	});

	it("is idempotent for sources it leaves alone", () => {
		fc.assert(fc.property(hostileSource, (source) => {
			const once = augmentSource(source, "fuzz.ts");
			fc.pre(once === source);
			expect(augmentSource(once, "fuzz.ts")).toBe(source);
		}), { numRuns: runs });
	});
});

describe("ambient declaration scanning", () => {
	it("never crashes on arbitrary text", () => {
		fc.assert(fc.property(fc.string({ maxLength: 400 }), (source) => {
			expect(() => scanDeclaredTrainables(source)).not.toThrow();
		}), { numRuns: runs });
	});

	it("rejects non-string input with a TypeError rather than coercing", () => {
		for (const value of [undefined, null, 1, {}, [], true]) {
			expect(() => scanDeclaredTrainables(value as never)).toThrow(TypeError);
		}
	});

	it("only reports operations with a non-empty method and contract ref", () => {
		fc.assert(fc.property(hostileSource, (source) => {
			for (const declared of scanDeclaredTrainables(source)) {
				for (const operation of declared.operations) {
					expect(operation.method.length).toBeGreaterThan(0);
					expect(operation.contractRef.length).toBeGreaterThan(0);
					expect(operation.intent.length).toBeGreaterThan(0);
				}
			}
		}), { numRuns: runs });
	});
});

describe("the evolve kill switch", () => {
	it("only ever enables on a recognized affirmative or an unset value", () => {
		fc.assert(fc.property(fc.string({ maxLength: 20 }), (value) => {
			let enabled: boolean;
			try {
				enabled = evolutionEnabled(value);
			} catch {
				return;
			}
			const flag = value.trim().toLowerCase();
			expect(enabled).toBe(flag === "" || ["1", "true", "on", "yes", "enabled"].includes(flag));
		}), { numRuns: 500 });
	});
});

describe("the command line", () => {
	it("never throws for arbitrary argv, and always reports a usable exit code", async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(fc.string({ maxLength: 20 }), { maxLength: 8 }),
			async (argv) => {
				const result = await run(argv);
				expect([0, 1, 2]).toContain(result.code);
				expect((result.code === 0 ? result.stdout : result.stderr).length).toBeGreaterThan(0);
			},
		), { numRuns: 150 });
	});

	it("never leaks a stack trace to stderr", async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(fc.oneof(fc.constantFrom("discover", "status", "help", "--json", "--cwd", "--file", "--nope"),
				fc.string({ maxLength: 12 })), { maxLength: 6 }),
			async (argv) => {
				const result = await run(argv);
				expect(result.stderr).not.toMatch(/\n\s+at /);
			},
		), { numRuns: 150 });
	});
});

function safeDiscover(source: string) {
	try {
		return discoverInSource(source, "fuzz.ts");
	} catch {
		return [];
	}
}

describe("the fuzz corpus itself", () => {
	const corpusSeed = 1;

	it("produces modules that discovery actually finds targets in", () => {
		let withTargets = 0;
		for (const source of fc.sample(markedModule, { numRuns: 100, seed: corpusSeed })) {
			if (discoverInSource(source, "fuzz.ts").length > 0) withTargets += 1;
		}
		expect(withTargets).toBeGreaterThan(80);
	});

	it("produces damaged modules that still often parse", () => {
		let withTargets = 0;
		for (const source of fc.sample(damagedModule, { numRuns: 200, seed: corpusSeed })) {
			if (safeDiscover(source).length > 0) withTargets += 1;
		}
		expect(withTargets).toBeGreaterThan(10);
		expect(withTargets).toBeLessThan(200);
	});

	it("produces modules the load hook actually rewrites", () => {
		let rewritten = 0;
		for (const source of fc.sample(markedModule, { numRuns: 100, seed: corpusSeed })) {
			if (augmentSource(source, "fuzz.ts") !== source) rewritten += 1;
		}
		expect(rewritten).toBeGreaterThan(80);
	});
});
