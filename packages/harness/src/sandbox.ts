import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { spawnSandboxAsync, type SandboxPolicy } from "@microsoft/mxc-sdk";
import {
	BaseSandbox,
	type ExecuteResponse,
	type FileDownloadResponse,
	type FileUploadResponse,
} from "deepagents";

import { attemptAsync } from "./attempt.js";
import { WriteAheadAgentBus } from "./bus.js";
import { dispatchAction, type ActionGate } from "./dispatch.js";
import { createSandboxPolicy } from "./policy.js";
import { absolutePath } from "./schema.js";

export interface HarnessSandboxSettings {
	readonly id: string;
	readonly workspace: string;
	readonly bus: WriteAheadAgentBus;
	/** The bus actor this sandbox's operations are recorded as. */
	readonly actor: string;
	/** Gate consulted before every operation runs; without one, operations are
	 * still written ahead and recorded but execute ungated. */
	readonly gate?: ActionGate;
	/** Paths that must remain outside the writable workspace — for example a
	 * file-backed bus log the sandboxed agent must not be able to tamper with. */
	readonly protectedPaths?: readonly string[];
	/** Absolute paths outside the workspace the sandboxed process may read. */
	readonly readonlyPaths?: readonly string[];
	/** Hosts the sandboxed process may reach. Outbound network is denied
	 * without them; local network access is always denied. */
	readonly allowedHosts?: readonly string[];
	readonly timeoutMs?: number;
}

export class HarnessSandbox extends BaseSandbox {
	readonly id: string;
	readonly #workspace: string;
	readonly #policy: SandboxPolicy;
	readonly #bus: WriteAheadAgentBus;
	readonly #actor: string;
	readonly #gate: ActionGate | undefined;

	constructor(settings: HarnessSandboxSettings) {
		super();
		this.id = settings.id;
		this.#workspace = resolve(settings.workspace);
		this.#policy = createSandboxPolicy({
			workspace: this.#workspace,
			readonlyPaths: settings.readonlyPaths && [...settings.readonlyPaths],
			allowedHosts: settings.allowedHosts && [...settings.allowedHosts],
			timeoutMs: settings.timeoutMs,
		});
		for (const path of settings.protectedPaths ?? []) {
			const fromWorkspace = relative(this.#workspace, absolutePath.parse(path));
			if (!fromWorkspace.startsWith("..") && !isAbsolute(fromWorkspace)) {
				throw new TypeError("protected paths must be outside the writable sandbox workspace");
			}
		}
		this.#bus = settings.bus;
		this.#actor = settings.actor;
		this.#gate = settings.gate;
	}

	async execute(command: string): Promise<ExecuteResponse> {
		return this.#perform("sandbox.execute", { sandbox: this.id, command }, async () => {
			await mkdir(this.#workspace, { recursive: true });
			const result = await spawnSandboxAsync(command, this.#policy, {}, this.#workspace, this.id);
			return {
				output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
				exitCode: result.exitCode,
				truncated: false,
			};
		});
	}

	async uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
		return this.#perform("sandbox.upload", { sandbox: this.id, paths: files.map(([path]) => path) }, () =>
			Promise.all(files.map(([path, content]) => attemptAsync<FileUploadResponse>(async () => {
				const target = this.#path(path);
				await mkdir(this.#workspace, { recursive: true });
				// Preflight before mkdir: a symlinked ancestor would otherwise create directories outside.
				await this.#assertContained(await existingAncestor(dirname(target), this.#workspace));
				await mkdir(dirname(target), { recursive: true });
				await this.#assertContained(dirname(target));
				if (await isSymlink(target)) throw new Error("path escapes sandbox workspace");
				await writeFile(target, content);
				return { path, error: null };
			}, () => ({ path, error: "permission_denied" as const })))));
	}

	async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
		return this.#perform("sandbox.download", { sandbox: this.id, paths }, () =>
			Promise.all(paths.map((path) => attemptAsync<FileDownloadResponse>(async () => {
				const target = this.#path(path);
				await this.#assertContained(target);
				return { path, content: await readFile(target), error: null };
			}, () => ({ path, content: null, error: "file_not_found" as const })))));
	}

	#perform<T>(kind: string, payload: unknown, execute: () => Promise<T>): Promise<T> {
		return dispatchAction(this.#bus, this.#actor, kind, payload, this.#gate, execute);
	}

	#path(path: string): string {
		const target = resolve(this.#workspace, isAbsolute(path) ? `.${path}` : path);
		const fromWorkspace = relative(this.#workspace, target);
		if (fromWorkspace.startsWith("..") || isAbsolute(fromWorkspace)) throw new Error("path escapes sandbox workspace");
		return target;
	}

	/** Host file access follows symlinks, so containment must hold after resolving them too. */
	async #assertContained(path: string): Promise<void> {
		const fromWorkspace = relative(await realpath(this.#workspace), await realpath(path));
		if (fromWorkspace.startsWith("..") || isAbsolute(fromWorkspace)) {
			throw new Error("path escapes sandbox workspace");
		}
	}
}

function isSymlink(path: string): Promise<boolean> {
	return attemptAsync(async () => (await lstat(path)).isSymbolicLink(), () => false);
}

async function existingAncestor(path: string, root: string): Promise<string> {
	let current = path;
	while (current !== root && !(await exists(current))) current = dirname(current);
	return current;
}

function exists(path: string): Promise<boolean> {
	return attemptAsync(async () => {
		await lstat(path);
		return true;
	}, () => false);
}
