import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
	spawnSandboxAsync,
	type SandboxPolicy,
	type SandboxSpawnOptions,
} from "@microsoft/mxc-sdk";
import {
	BaseSandbox,
	type ExecuteResponse,
	type FileDownloadResponse,
	type FileUploadResponse,
} from "deepagents";

import { WriteAheadAgentBus } from "./bus.js";
import { dispatchAction, type ActionGate } from "./dispatch.js";
import { assertHarnessPolicy } from "./policy.js";

export interface MxcSandboxSettings {
	readonly id: string;
	readonly workspace: string;
	readonly policy: SandboxPolicy;
	readonly bus: WriteAheadAgentBus;
	/** The bus actor this sandbox's operations are recorded as. */
	readonly actor: string;
	/** Gate consulted before every operation runs; without one, operations are
	 * still written ahead and recorded but execute ungated. */
	readonly gate?: ActionGate;
	readonly spawn?: Omit<SandboxSpawnOptions, "usePty">;
}

export class MxcSandbox extends BaseSandbox {
	readonly id: string;
	readonly #workspace: string;
	readonly #policy: SandboxPolicy;
	readonly #bus: WriteAheadAgentBus;
	readonly #actor: string;
	readonly #gate: ActionGate | undefined;
	readonly #spawn: Omit<SandboxSpawnOptions, "usePty">;

	constructor(settings: MxcSandboxSettings) {
		super();
		this.id = settings.id;
		this.#workspace = resolve(settings.workspace);
		assertHarnessPolicy(settings.policy, this.#workspace);
		const busPath = relative(this.#workspace, settings.bus.file);
		if (!busPath.startsWith("..") && !isAbsolute(busPath)) {
			throw new TypeError("agent bus file must be outside the writable sandbox workspace");
		}
		this.#policy = settings.policy;
		this.#bus = settings.bus;
		this.#actor = settings.actor;
		this.#gate = settings.gate;
		this.#spawn = settings.spawn ?? {};
	}

	async execute(command: string): Promise<ExecuteResponse> {
		return this.#perform("sandbox.execute", { sandbox: this.id, command }, async () => {
			await mkdir(this.#workspace, { recursive: true });
			const result = await spawnSandboxAsync(
				command,
				this.#policy,
				this.#spawn,
				this.#workspace,
				this.id,
			);
			return {
				output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
				exitCode: result.exitCode,
				truncated: false,
			};
		});
	}

	async uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
		return this.#perform("sandbox.upload", { sandbox: this.id, paths: files.map(([path]) => path) }, () =>
			Promise.all(files.map(async ([path, content]) => {
				try {
					const target = this.#path(path);
					await mkdir(this.#workspace, { recursive: true });
					// Preflight before mkdir: a symlinked ancestor would otherwise create directories outside.
					await this.#assertContained(await existingAncestor(dirname(target), this.#workspace));
					await mkdir(dirname(target), { recursive: true });
					await this.#assertContained(dirname(target));
					if (await isSymlink(target)) throw new Error("path escapes sandbox workspace");
					await writeFile(target, content);
					return { path, error: null };
				} catch {
					return { path, error: "permission_denied" as const };
				}
			})));
	}

	async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
		return this.#perform("sandbox.download", { sandbox: this.id, paths }, () =>
			Promise.all(paths.map(async (path) => {
				try {
					const target = this.#path(path);
					await this.#assertContained(target);
					return { path, content: await readFile(target), error: null };
				} catch {
					return { path, content: null, error: "file_not_found" as const };
				}
			})));
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

async function isSymlink(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isSymbolicLink();
	} catch {
		return false;
	}
}

async function existingAncestor(path: string, root: string): Promise<string> {
	let current = path;
	while (current !== root && !(await exists(current))) current = dirname(current);
	return current;
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}
