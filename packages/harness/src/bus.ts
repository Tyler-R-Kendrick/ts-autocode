import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export type AgentRole = "student" | "teacher" | "judge" | "adversary";
export type JudgeDecision = "pass" | "fail";

export interface AgentAction {
	readonly id: string;
	readonly role: AgentRole;
	readonly kind: string;
	readonly payload: unknown;
}

export interface AgentBusEntry extends AgentAction {
	readonly sequence: number;
	readonly timestamp: string;
	readonly phase: "proposed" | "approved" | "denied" | "completed" | "failed";
	readonly detail?: unknown;
}

export interface AgentBusSettings {
	readonly file: string;
	readonly contextEntries?: number;
	readonly idFactory?: () => string;
	readonly now?: () => Date;
	readonly redact?: (value: unknown) => unknown;
}

export type ActionJudge = (
	action: AgentAction,
	context: readonly AgentBusEntry[],
) => JudgeDecision | Promise<JudgeDecision>;

const judgeControlAction = Symbol("judgeControlAction");

export class AgentActionDeniedError extends Error {
	readonly action: AgentAction;

	constructor(action: AgentAction) {
		super(`judge denied ${action.role} action: ${action.kind}`);
		this.name = "AgentActionDeniedError";
		this.action = action;
	}
}

export class WriteAheadAgentBus {
	readonly file: string;
	readonly #contextEntries: number;
	readonly #idFactory: () => string;
	readonly #now: () => Date;
	readonly #redact: (value: unknown) => unknown;
	#judge?: ActionJudge;
	#sequence = 0;
	#initialized = false;
	#pending: Promise<void> = Promise.resolve();

	constructor(settings: AgentBusSettings) {
		if (!isAbsolute(settings.file)) throw new TypeError("agent bus file must be absolute");
		const contextEntries = settings.contextEntries ?? 100;
		if (!Number.isInteger(contextEntries) || contextEntries < 1) {
			throw new TypeError("contextEntries must be a positive integer");
		}
		this.file = resolve(settings.file);
		this.#contextEntries = contextEntries;
		this.#idFactory = settings.idFactory ?? randomUUID;
		this.#now = settings.now ?? (() => new Date());
		this.#redact = settings.redact ?? ((value) => value);
	}

	setJudge(judge: ActionJudge): void {
		if (this.#judge) throw new Error("agent bus judge is already configured");
		this.#judge = judge;
	}

	async dispatch<T>(role: Exclude<AgentRole, "judge">, kind: string, payload: unknown, execute: () => Promise<T>): Promise<T> {
		const judge = this.#judge;
		if (!judge) throw new Error("agent bus judge is not configured");
		const action = this.#action(role, kind, payload);
		await this.#append(action, "proposed");
		let decision: JudgeDecision;
		try {
			decision = await judge(action, await this.context());
			if (decision !== "pass" && decision !== "fail") throw new Error("judge must return exactly pass or fail");
		} catch (error) {
			await this.#append(action, "failed", { stage: "judge", message: error instanceof Error ? error.message : String(error) });
			throw error;
		}
		await this.#append(action, decision === "pass" ? "approved" : "denied", { decision });
		if (decision === "fail") throw new AgentActionDeniedError(action);
		return this.#execute(action, execute);
	}

	async [judgeControlAction]<T>(kind: string, payload: unknown, execute: () => Promise<T>): Promise<T> {
		const action = this.#action("judge", kind, payload);
		await this.#append(action, "proposed");
		await this.#append(action, "approved", { bootstrap: true });
		return this.#execute(action, execute);
	}

	async context(role?: AgentRole): Promise<readonly AgentBusEntry[]> {
		await this.#pending;
		let content: string;
		try {
			content = await readFile(this.file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const entries = parseEntries(content);
		const filtered = role === undefined ? entries : entries.filter((entry) => entry.role === role);
		return Object.freeze(filtered.slice(-this.#contextEntries).map((entry) => Object.freeze(entry)));
	}

	async #execute<T>(action: AgentAction, execute: () => Promise<T>): Promise<T> {
		try {
			const result = await execute();
			await this.#append(action, "completed", this.#redact(result));
			return result;
		} catch (error) {
			await this.#append(action, "failed", { message: error instanceof Error ? error.message : String(error) });
			throw error;
		}
	}

	#action(role: AgentRole, kind: string, payload: unknown): AgentAction {
		if (!kind.trim()) throw new TypeError("agent action kind must be non-empty");
		const id = this.#idFactory().trim();
		if (!id) throw new TypeError("agent action id must be non-empty");
		return Object.freeze({ id, role, kind, payload: this.#redact(payload) });
	}

	async #append(action: AgentAction, phase: AgentBusEntry["phase"], detail?: unknown): Promise<void> {
		const write = this.#pending.then(async () => {
			await mkdir(dirname(this.file), { recursive: true });
			if (!this.#initialized) {
				this.#sequence = await lastSequence(this.file);
				this.#initialized = true;
			}
			const entry: AgentBusEntry = {
				...action,
				sequence: ++this.#sequence,
				timestamp: this.#now().toISOString(),
				phase,
				...(detail === undefined ? {} : { detail: this.#redact(detail) }),
			};
			const handle = await open(this.file, "a");
			try {
				await handle.appendFile(`${safeJson(entry)}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
		});
		this.#pending = write.catch(() => undefined);
		await write;
	}
}

export function judgeControl<T>(
	bus: WriteAheadAgentBus,
	kind: string,
	payload: unknown,
	execute: () => Promise<T>,
): Promise<T> {
	return bus[judgeControlAction](kind, payload, execute);
}

export function parseJudgeDecision(result: unknown): JudgeDecision {
	const content = lastContent(result).trim().toLowerCase();
	if (content === "pass" || content === "fail") return content;
	throw new Error("judge must return exactly pass or fail");
}

function lastContent(result: unknown): string {
	if (typeof result === "string") return result;
	if (!result || typeof result !== "object" || !("messages" in result) || !Array.isArray(result.messages)) return "";
	const message = result.messages.at(-1);
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.map((block: unknown) => {
		if (typeof block === "string") return block;
		return block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : "";
	}).join("");
}

async function lastSequence(file: string): Promise<number> {
	try {
		const entries = parseEntries(await readFile(file, "utf8"));
		return entries.at(-1)?.sequence ?? 0;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
}

function parseEntries(content: string): AgentBusEntry[] {
	const lines = content.split("\n");
	const entries: AgentBusEntry[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]?.trim();
		if (!line) continue;
		try {
			entries.push(JSON.parse(line) as AgentBusEntry);
		} catch (error) {
			if (index !== lines.length - 1) throw error;
		}
	}
	return entries;
}

function safeJson(value: unknown): string {
	const seen = new WeakSet<object>();
	return JSON.stringify(value, (_key, item: unknown) => {
		if (typeof item === "bigint") return item.toString();
		if (!item || typeof item !== "object") return item;
		if (seen.has(item)) return "[Circular]";
		seen.add(item);
		return item;
	});
}
