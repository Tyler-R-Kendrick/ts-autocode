class Router {
	route(input: string): string {
		"use training";
		return input.toUpperCase();
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
