import { isAbsolute, resolve } from "node:path";

import type { SandboxPolicy } from "@microsoft/mxc-sdk";

export interface HarnessPolicySettings {
	readonly workspace: string;
	readonly readonlyPaths?: readonly string[];
	readonly allowedHosts?: readonly string[];
	readonly timeoutMs?: number;
}

export function createHarnessPolicy(settings: HarnessPolicySettings): SandboxPolicy {
	const workspace = absolute(settings.workspace, "workspace");
	const readonlyPaths = settings.readonlyPaths?.map((path) => absolute(path, "readonlyPaths"));
	const allowedHosts = settings.allowedHosts?.map((host) => host.trim()).filter(Boolean);

	return {
		version: "0.7.0-alpha",
		filesystem: {
			readwritePaths: [workspace],
			...(readonlyPaths?.length ? { readonlyPaths: [...readonlyPaths] } : {}),
		},
		network: allowedHosts?.length
			? { allowOutbound: true, allowLocalNetwork: false, allowedHosts: [...allowedHosts] }
			: { allowOutbound: false, allowLocalNetwork: false },
		ui: { allowWindows: false, clipboard: "none", allowInputInjection: false },
		...(settings.timeoutMs === undefined ? {} : { timeoutMs: positive(settings.timeoutMs) }),
	};
}

export function assertHarnessPolicy(policy: SandboxPolicy, workspace: string): void {
	const root = absolute(workspace, "workspace");
	const writable = policy.filesystem?.readwritePaths?.map((path) => resolve(path)) ?? [];
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

function absolute(path: string, field: string): string {
	if (!isAbsolute(path)) throw new TypeError(`${field} must contain absolute paths`);
	return resolve(path);
}

function positive(value: number): number {
	if (!Number.isInteger(value) || value < 1) throw new TypeError("timeoutMs must be a positive integer");
	return value;
}
