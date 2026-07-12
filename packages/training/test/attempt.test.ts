import { describe, expect, it } from "vitest";

import { attempt, attemptAsync, errorMessage } from "../src/attempt.js";

describe("attempt fallbacks", () => {
	it("passes the raw thrown value to the sync fallback", () => {
		const failure = new Error("sync boom");
		let received: unknown;

		const result = attempt<string>(() => { throw failure; }, (error) => {
			received = error;
			return "fell back";
		});

		expect(result).toBe("fell back");
		expect(received).toBe(failure);
	});

	it("passes the raw rejection to the async fallback", async () => {
		const failure = new Error("async boom");
		let received: unknown;

		const result = await attemptAsync<string>(async () => { throw failure; }, (error) => {
			received = error;
			return "fell back";
		});

		expect(result).toBe("fell back");
		expect(received).toBe(failure);
	});

	it("returns the function result untouched on success", async () => {
		expect(attempt(() => 7, () => 0)).toBe(7);
		await expect(attemptAsync(async () => 7, () => 0)).resolves.toBe(7);
	});

	it("stringifies non-Error values in errorMessage", () => {
		expect(errorMessage(new Error("named"))).toBe("named");
		expect(errorMessage("plain")).toBe("plain");
	});
});
