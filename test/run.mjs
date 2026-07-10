import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const temporaryDirectory = resolve("test/output/tmp");
await mkdir(temporaryDirectory, { recursive: true });

const vitest = resolve("node_modules/vitest/vitest.mjs");
const child = spawn(process.execPath, [vitest, "run", ...process.argv.slice(2)], {
	stdio: "inherit",
	env: {
		...process.env,
		TEMP: temporaryDirectory,
		TMP: temporaryDirectory,
		TMPDIR: temporaryDirectory,
	},
});

child.on("exit", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exitCode = code ?? 1;
});
