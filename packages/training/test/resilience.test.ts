import { describe, expect, it, vi } from "vitest";

import { OperationTimeoutError, withPolicy } from "../src/index.js";

describe("withPolicy", () => {
	it("is a passthrough without a policy", async () => {
		const signal = new AbortController().signal;
		const fn = vi.fn(async (received?: AbortSignal) => {
			expect(received).toBe(signal);
			return 42;
		});

		await expect(withPolicy(undefined, "op", fn, signal)).resolves.toBe(42);
		await expect(withPolicy({}, "op", fn, signal)).resolves.toBe(42);
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("rejects with the original error without a policy", async () => {
		const failure = new Error("boom");

		await expect(withPolicy(undefined, "op", async () => { throw failure; })).rejects.toBe(failure);
	});

	it("retries until an attempt succeeds", async () => {
		let attempts = 0;

		const result = await withPolicy({ retry: { attempts: 3, delayMs: 1, jitter: false } }, "op", async () => {
			attempts += 1;
			if (attempts < 3) throw new Error(`attempt ${attempts} failed`);
			return "ok";
		});

		expect(result).toBe("ok");
		expect(attempts).toBe(3);
	});

	it("rethrows the last original error unwrapped when retries are exhausted", async () => {
		const failures = [new Error("first"), new Error("second")];
		let attempts = 0;

		await expect(withPolicy(
			{ retry: { attempts: 2, delayMs: 1, jitter: false } },
			"op",
			async () => { throw failures[attempts++]; },
		)).rejects.toBe(failures[1]);
		expect(attempts).toBe(2);
	});

	it("does not retry failures the policy marks non-retryable", async () => {
		let attempts = 0;

		await expect(withPolicy(
			{ retry: { attempts: 3, delayMs: 1, retryable: (error) => !(error instanceof TypeError) } },
			"op",
			async () => {
				attempts += 1;
				throw new TypeError("bad input");
			},
		)).rejects.toThrow("bad input");
		expect(attempts).toBe(1);
	});

	it("fails a hung attempt with a typed timeout and aborts the attempt signal", async () => {
		let observed: AbortSignal | undefined;

		const rejection = withPolicy({ timeoutMs: 20 }, "slow.op", (signal) => {
			observed = signal;
			return new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
		});

		const error: unknown = await rejection.then(() => undefined, (thrown: unknown) => thrown);
		expect(error).toBeInstanceOf(OperationTimeoutError);
		expect(error).toMatchObject({ _tag: "OperationTimeout", operation: "slow.op", timeoutMs: 20 });
		expect((error as Error).message).toBe("slow.op timed out after 20ms");
		expect(observed?.aborted).toBe(true);
	});

	it("retries timed-out attempts by default", async () => {
		let attempts = 0;

		const result = await withPolicy(
			{ timeoutMs: 100, retry: { attempts: 2, delayMs: 1, jitter: false } },
			"op",
			async () => {
				attempts += 1;
				if (attempts === 1) await new Promise((resolve) => setTimeout(resolve, 1_000));
				return "ok";
			},
		);

		expect(result).toBe("ok");
		expect(attempts).toBe(2);
	});

	it("stops retrying when the caller aborts during backoff", async () => {
		const controller = new AbortController();
		const reason = new Error("stop now");
		let attempts = 0;

		const pending = withPolicy(
			{ retry: { attempts: 5, delayMs: 5_000, jitter: false } },
			"op",
			async () => {
				attempts += 1;
				throw new Error("flaky");
			},
			controller.signal,
		);
		setTimeout(() => controller.abort(reason), 20);

		await expect(pending).rejects.toBe(reason);
		expect(attempts).toBe(1);
	});
});
