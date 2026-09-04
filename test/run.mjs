import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { orphanedSnapshots, resetVerifiedMarkers } from "./support/snapshot-manifest.mjs";

const temporaryDirectory = resolve("test/output/tmp");
await mkdir(temporaryDirectory, { recursive: true });
await resetVerifiedMarkers();

const args = process.argv.slice(2);
// Anything that is not a flag is a file filter, and a filtered run legitimately
// compares against almost no approved snapshots, so the orphan check below
// only applies when the whole suite ran.
const fullRun = args.every((argument) => argument.startsWith("-"));

const vitest = resolve("node_modules/vitest/vitest.mjs");
const child = spawn(process.execPath, [vitest, "run", ...args], {
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
	void reportOrphans(code === 0 && fullRun);
});

async function reportOrphans(enabled) {
	if (!enabled) return;
	// Swallowed rather than left to reject: this runs fire-and-forget from the
	// exit handler, so an unhandled rejection would crash a passing run with a
	// stack trace. A check that cannot run is not a failing check.
	const orphans = await orphanedSnapshots().catch(() => []);
	if (orphans.length === 0) return;
	process.exitCode = 1;
	process.stderr.write(
		`\n${orphans.length} approved snapshot${orphans.length === 1 ? "" : "s"} no longer compared against by any `
		+ `test, so nothing would notice ${orphans.length === 1 ? "it" : "them"} going stale:\n`
		+ `${orphans.map((file) => `  ${file}`).join("\n")}\n`
		+ "Delete them, or point a `verify(...)` call at them again.\n",
	);
}
