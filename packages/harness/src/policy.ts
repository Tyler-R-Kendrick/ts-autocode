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

export type HarnessPolicySettings = z.input<typeof policySettings>;

/** The mxc-sdk policy schema version emitted when `version` is unset. */
export const sandboxPolicyVersion = "0.7.0-alpha";

export function createHarnessPolicy(input: HarnessPolicySettings): SandboxPolicy {
	const settings = policySettings.parse(input);
	const allowedHosts = settings.allowedHosts?.filter(Boolean);

	return {
		version: settings.version ?? sandboxPolicyVersion,
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

/** Enforces the harness's security invariants on a sandbox policy: writes
 * confined to the workspace, no local network or proxy escape, outbound only
 * with an explicit allowlist, and no UI, clipboard, or input access. */
export function assertHarnessPolicy(policy: SandboxPolicy, workspace: string): void {
	const root = absolutePath.parse(workspace);
	const writable = policy.filesystem?.readwritePaths?.map((path) => absolutePath.parse(path)) ?? [];
	if (writable.length !== 1 || writable[0] !== root) {
		throw new TypeError("policy must grant write access only to the sandbox workspace");
	}
	if (policy.network?.allowLocalNetwork) throw new TypeError("policy cannot grant local network access");
	if (policy.network?.proxy) throw new TypeError("policy cannot bypass the host allowlist with a proxy");
	if (policy.network?.allowOutbound && !policy.network.allowedHosts?.length) {
		throw new TypeError("outbound access requires allowedHosts");
	}
	if (policy.ui?.allowWindows || policy.ui?.allowInputInjection || (policy.ui?.clipboard ?? "none") !== "none") {
		throw new TypeError("policy cannot grant UI, clipboard, or input access");
	}
}
