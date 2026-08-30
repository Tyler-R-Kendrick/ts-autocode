class Router {
	route(input: string): string {
		"use training";
		return input.includes("invoice") ? "billing" : "fallback";
	}

	async enrich(id: string, deep?: boolean): Promise<string> {
		"use training";
		return `${id}:${deep}`;
	}
}

export function normalize(input: string): string {
	"use training";
	return input.trim();
}

;globalThis[Symbol.for("ts-autocode.instrument")]?.([
    { id: "Router.route", name: "route", owner: () => Router },
    { id: "Router.enrich", name: "enrich", owner: () => Router },
    { id: "normalize", get: () => normalize, set: __fn => { normalize = __fn; } }
]);
