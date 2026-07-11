import { mkdir, readFile, writeFile } from "node:fs/promises";
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

import { judgeControl, WriteAheadAgentBus, type AgentRole } from "./bus.js";
import { assertHarnessPolicy } from "./policy.js";

export interface MxcSandboxSettings {
	readonly id: string;
	readonly workspace: string;
	readonly policy: SandboxPolicy;
	readonly bus: WriteAheadAgentBus;
	readonly role: AgentRole;
	readonly spawn?: Omit<SandboxSpawnOptions, "usePty">;
}

export class MxcSandbox extends BaseSandbox {
	readonly id: string;
	readonly #workspace: string;
	readonly #policy: SandboxPolicy;
	readonly #bus: WriteAheadAgentBus;
	readonly #role: AgentRole;
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
		this.#role = settings.role;
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
					await mkdir(dirname(target), { recursive: true });
					await writeFile(target, content);
					return { path, error: null };
				} catch (error) {
					return { path, error: "permission_denied" as const };
				}
			})));
	}

	async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
		return this.#perform("sandbox.download", { sandbox: this.id, paths }, () =>
			Promise.all(paths.map(async (path) => {
				try {
					return { path, content: await readFile(this.#path(path)), error: null };
				} catch (error) {
					return { path, content: null, error: "file_not_found" as const };
				}
			})));
	}

	#perform<T>(kind: string, payload: unknown, execute: () => Promise<T>): Promise<T> {
		return this.#role === "judge"
			? judgeControl(this.#bus, kind, payload, execute)
			: this.#bus.dispatch(this.#role, kind, payload, execute);
	}

	#path(path: string): string {
		const target = resolve(this.#workspace, isAbsolute(path) ? `.${path}` : path);
		const fromWorkspace = relative(this.#workspace, target);
		if (fromWorkspace.startsWith("..") || isAbsolute(fromWorkspace)) throw new Error("path escapes sandbox workspace");
		return target;
	}
}
