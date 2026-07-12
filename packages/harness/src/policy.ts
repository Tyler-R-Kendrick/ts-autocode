import { createRequire } from "node:module";

import type { SandboxPolicy } from "@microsoft/mxc-sdk";
import { z } from "zod";

import { absolutePath } from "./schema.js";

const policySettings = z.object({
	workspace: absolutePath,
	readonlyPaths: z.array(absolutePath).optional(),
	allowedHosts: z.array(z.string().trim()).optional(),
	timeoutMs: z.number().int().positive("timeoutMs must be a positive integer").optional(),
	version: z.string().optional(),
});

export type SandboxPolicySettings = z.input<typeof policySettings>;

// The SDK requires a policy schema version on every policy but exports no
// constant for it; each release accepts its own package version, so defaulting
// to that tracks SDK upgrades without a hand-maintained copy here.
const installedSdkVersion = (
	createRequire(import.meta.url)("@microsoft/mxc-sdk/package.json") as { version: string }
).version;

/** Builds the harness's default sandbox policy: writes confined to the
 * workspace, no local network, outbound only with an explicit `allowedHosts`
 * allowlist, and no UI, clipboard, or input access. This is a convenience
 * default, not a requirement — consumers needing different guarantees can
 * hand `HarnessSandbox` any `SandboxPolicy`, including one built by spreading
 * over this result. */
export function createSandboxPolicy(input: SandboxPolicySettings): SandboxPolicy {
	const settings = policySettings.parse(input);
	const allowedHosts = settings.allowedHosts?.filter(Boolean);

	return {
		version: settings.version ?? installedSdkVersion,
		filesystem: {
			readwritePaths: [settings.workspace],
			...(settings.readonlyPaths?.length ? { readonlyPaths: [...settings.readonlyPaths] } : {}),
		},
		network: allowedHosts?.length
			? { allowOutbound: true, allowLocalNetwork: false, allowedHosts: [...allowedHosts] }
			: { allowOutbound: false, allowLocalNetwork: false },
		ui: { allowWindows: false, clipboard: "none", allowInputInjection: false },
		...(settings.timeoutMs === undefined ? {} : { timeoutMs: settings.timeoutMs }),
	};
}
