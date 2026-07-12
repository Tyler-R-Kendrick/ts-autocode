import type { SandboxPolicy } from "@microsoft/mxc-sdk";
import { z } from "zod";

import { absolutePath } from "./schema.js";

const policySettings = z.object({
	workspace: absolutePath,
	readonlyPaths: z.array(absolutePath).optional(),
	allowedHosts: z.array(z.string().trim()).optional(),
	timeoutMs: z.number().int().positive("timeoutMs must be a positive integer").optional(),
});

export type SandboxPolicySettings = z.input<typeof policySettings>;

const policyVersion = "0.7.0-alpha";

/** Builds a sandbox policy under the harness's security invariants: writes
 * confined to the workspace, no local network, outbound only with an explicit
 * allowlist, and no UI, clipboard, or input access. */
export function createSandboxPolicy(input: SandboxPolicySettings): SandboxPolicy {
	const settings = policySettings.parse(input);
	const allowedHosts = settings.allowedHosts?.filter(Boolean);

	return {
		version: policyVersion,
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
