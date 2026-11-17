import { createRequire } from "node:module";

import type { SandboxPolicy } from "@microsoft/mxc-sdk";
import { z } from "zod";

import { absolutePath, positiveIntegerSetting } from "./schema.js";

const policySettings = z.object({
	workspace: absolutePath,
	readonlyPaths: z.array(absolutePath).optional(),
	allowedHosts: z.array(z.string().trim()).optional(),
	timeoutMs: positiveIntegerSetting("timeoutMs must be a positive integer").optional(),
	version: z.string().optional(),
});

export type SandboxPolicySettings = z.input<typeof policySettings>;

const installedSdkVersion = (
	createRequire(import.meta.url)("@microsoft/mxc-sdk/package.json") as { version: string }
).version;

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
