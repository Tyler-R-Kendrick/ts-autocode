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

import { assertHarnessPolicy } from "./policy.js";

export interface MxcSandboxSettings {
	readonly id: string;
	readonly workspace: string;
	readonly policy: SandboxPolicy;
	readonly spawn?: Omit<SandboxSpawnOptions, "usePty">;
}

export class MxcSandbox extends BaseSandbox {
	readonly id: string;
	readonly #workspace: string;
	readonly #policy: SandboxPolicy;
	readonly #spawn: Omit<SandboxSpawnOptions, "usePty">;

	constructor(settings: MxcSandboxSettings) {
		super();
		this.id = settings.id;
		this.#workspace = resolve(settings.workspace);
		assertHarnessPolicy(settings.policy, this.#workspace);
		this.#policy = settings.policy;
		this.#spawn = settings.spawn ?? {};
	}

	async execute(command: string): Promise<ExecuteResponse> {
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
	}

	async uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
		return Promise.all(files.map(async ([path, content]) => {
			try {
				const target = this.#path(path);
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, content);
				return { path, error: null };
			} catch (error) {
				return { path, error: "permission_denied" as const };
			}
		}));
	}

	async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
		return Promise.all(paths.map(async (path) => {
			try {
				return { path, content: await readFile(this.#path(path)), error: null };
			} catch (error) {
				return { path, content: null, error: "file_not_found" as const };
			}
		}));
	}

	#path(path: string): string {
		const target = resolve(this.#workspace, isAbsolute(path) ? `.${path}` : path);
		const fromWorkspace = relative(this.#workspace, target);
		if (fromWorkspace.startsWith("..") || isAbsolute(fromWorkspace)) throw new Error("path escapes sandbox workspace");
		return target;
	}
}
