// Fixture for the promotion-rubric test: a directive-marked method the source
// scanner can discover.
export class Fixture {
	route(input: string): string {
		"use training";
		return input;
	}
}
