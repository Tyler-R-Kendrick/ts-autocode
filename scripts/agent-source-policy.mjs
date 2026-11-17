import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = spawnSync("git", ["rev-parse", "--show-toplevel"], {
	encoding: "utf8",
	stdio: ["ignore", "pipe", "pipe"],
});
if (repository.status !== 0 || !repository.stdout.trim()) {
	process.stderr.write("Source policy could not locate the repository.\n");
	process.exitCode = 2;
} else {
	const guard = fileURLToPath(new URL("./source-policy.mjs", import.meta.url));
	const result = spawnSync(process.execPath, [guard, "--worktree"], {
		cwd: repository.stdout.trim(),
		encoding: "utf8",
		env: { ...process.env, NODE_OPTIONS: "" },
		maxBuffer: 4 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 45_000,
	});
	if (result.status !== 0) {
		process.stderr.write(
			result.stderr ||
				result.error?.message ||
				`Source policy exited ${result.status}.\n`,
		);
		process.exitCode = 2;
	}
}
