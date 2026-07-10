import { createHash } from "node:crypto";

import { canonicalJson, isNonEmptyString, isRecord } from "./canonical.js";
import type { GeneratedRegion } from "./region.js";

export const TRAJECTORY_SCHEMA = "ts-autocode.training.trajectory/v2";

export const TRACEPARENT_PATTERN = /^00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/;

/** OpenInference span kinds — the trajectory capture vocabulary. */
export const OPENINFERENCE_SPAN_KINDS = new Set([
	"LLM",
	"CHAIN",
	"TOOL",
	"RETRIEVER",
	"RERANKER",
	"EMBEDDING",
	"AGENT",
	"GUARDRAIL",
	"EVALUATOR",
	"PROMPT",
]);

const SENSITIVE_CLASSIFICATIONS = new Set(["pii", "secret", "confidential", "regulated"]);
const SCORE_DATA_TYPES = new Set(["numeric", "categorical", "boolean"]);
const SPAN_STATUS_CODES = new Set(["OK", "ERROR", "UNSET"]);
const MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool"]);
const TRAJECTORY_ARMS = new Set(["champion", "challenger", "shadow"]);

/**
 * A named evaluation signal bound to a trajectory — the LangSmith-feedback /
 * Langfuse-score shape. A trajectory may carry many (accuracy, safety, cost
 * rubrics, human labels, …); by convention the optimizer's primary signal is
 * named "reward" with a numeric value in [0, 1].
 */
export interface Score {
	readonly name: string;
	readonly value: number | string | boolean;
	/** Inferred from the value's type when absent. */
	readonly dataType?: "numeric" | "categorical" | "boolean";
	/** Where the score came from (e.g. "live-eval", "held-out", "human-label", "api"). */
	readonly source: string;
	readonly rubricRef?: string;
	readonly comment?: string;
	readonly eventId?: string;
	readonly observedAt?: string;
}

/**
 * General feedback, Trace-style: an optimizer signal need not be a scalar.
 * A score, a natural-language critique, and a runtime error are all valid
 * inputs to `.backward()`-equivalent propagation.
 */
export type Feedback =
	| { readonly kind: "score"; readonly score: number }
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "error"; readonly message: string; readonly detail?: string };

/** Token usage, aligned with gen_ai.usage.* / llm.token_count.*. */
export interface Usage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly totalTokens?: number;
	readonly cacheReadInputTokens?: number;
	readonly reasoningOutputTokens?: number;
}

/** Cost in USD, aligned with OpenInference llm.cost.*. */
export interface Cost {
	readonly inputUsd?: number;
	readonly outputUsd?: number;
	readonly totalUsd?: number;
}

/**
 * Message content is either inline text or an external/redacted reference.
 * Ref-mode capture stores the ciphertext alongside the ref so the content
 * stays recoverable by whoever holds the run key.
 */
export type MessageContent = string | { readonly ref: string; readonly ciphertext?: string };

/** A chat message, aligned with gen_ai.input.messages / llm.input_messages.*. */
export interface GenAiMessage {
	readonly role: "system" | "user" | "assistant" | "tool";
	readonly content?: MessageContent;
	readonly toolCalls?: readonly {
		readonly id?: string;
		readonly name: string;
		readonly arguments?: string;
	}[];
	/** For role "tool": the tool_call id this message answers. */
	readonly toolCallId?: string;
}

/**
 * First-class GenAI call data on a span — the typed superset of OTel
 * gen_ai.* and OpenInference llm.* conventions. Required (requestModel +
 * usage) on spans of kind LLM.
 */
export interface GenAiSpanData {
	/** gen_ai.provider.name / llm.provider (e.g. "openai", "anthropic"). */
	readonly provider?: string;
	/** gen_ai.operation.name (e.g. "chat", "embeddings", "execute_tool"). */
	readonly operation?: string;
	/** gen_ai.request.model / llm.model_name. */
	readonly requestModel?: string;
	/** gen_ai.response.model. */
	readonly responseModel?: string;
	/** gen_ai.response.id. */
	readonly responseId?: string;
	/** gen_ai.response.finish_reasons / llm.finish_reason. */
	readonly finishReasons?: readonly string[];
	/** gen_ai.request.temperature/top_p/max_tokens/… / llm.invocation_parameters. */
	readonly invocationParameters?: Record<string, unknown>;
	readonly usage?: Usage;
	readonly cost?: Cost;
	/** Content capture is opt-in; use { ref } for external/redacted storage. */
	readonly inputMessages?: readonly GenAiMessage[];
	readonly outputMessages?: readonly GenAiMessage[];
	readonly systemInstructions?: MessageContent;
}

export interface SpanStatus {
	readonly code: "OK" | "ERROR" | "UNSET";
	readonly message?: string;
}

export interface TrajectorySpan {
	readonly id: string;
	readonly parentId?: string | null;
	/** 32-hex trace id; defaults to the trajectory's traceparent trace id. */
	readonly traceId?: string;
	readonly name: string;
	readonly startTime?: string;
	readonly endTime?: string;
	readonly status?: SpanStatus;
	/** Must include `openinference.span.kind`. Open map — extra keys are never stripped. */
	readonly attributes: Record<string, unknown>;
	readonly inputs?: Record<string, unknown>;
	readonly outputs?: Record<string, unknown>;
	readonly genAi?: GenAiSpanData;
}

/**
 * A named payload attached to a trajectory. Sensitive classifications must be
 * tokenized or encrypted before the trajectory may enter a training run.
 */
export interface TrajectoryPayload {
	readonly classification?: "public" | "pii" | "secret" | "confidential" | "regulated";
	readonly redaction?: "none" | "tokenized" | "encrypted";
	readonly value?: string;
	readonly tokenRef?: string;
	/** Required for encrypted payloads; must be scoped under `run://<runId>/`. */
	readonly encryptedRef?: string;
}

export interface TrajectoryRun {
	readonly id: string;
	readonly tenantId?: string;
	readonly agent?: {
		readonly id: string;
		readonly principalRef: string;
	};
}

/** Session/user/tag/metadata enrichment, aligned with OpenInference + Langfuse trace attributes. */
export interface TrajectoryContext {
	readonly session?: { readonly id: string };
	readonly user?: { readonly id: string };
	readonly tags?: readonly string[];
	readonly metadata?: Record<string, unknown>;
	/** Deployment context (production/staging/…). */
	readonly environment?: string;
	/** Application release/version that served this run. */
	readonly release?: string;
}

/**
 * The evolution linkage: which code produced this trajectory. Required —
 * training attribution is meaningless without it.
 */
export interface TrajectoryCode {
	/** sha256 digest of the generated-region body at execution time. */
	readonly regionDigest: string;
	/** Candidate that produced the region body, when not the original baseline. */
	readonly candidateId?: string;
	/** Which arm served this invocation. */
	readonly arm?: "champion" | "challenger" | "shadow";
}

/**
 * One observed execution of an optimizable method: correlated spans, the
 * generated region and code version it exercised, redaction-governed
 * payloads, and the optimizer signals — named scores, general feedback, or
 * both. At least one of `scores` / `feedback` must be present.
 *
 * Collection policy: this is a deliberate SUPERSET of what any single
 * methodology needs today; validation never strips unknown attributes.
 */
export interface Trajectory {
	readonly schema: typeof TRAJECTORY_SCHEMA;
	readonly id: string;
	/** W3C traceparent correlating the trajectory to distributed traces. */
	readonly traceparent: string;
	readonly run: TrajectoryRun;
	readonly subject: {
		readonly method: string;
		readonly contractRef: string;
		readonly generatedRegion: GeneratedRegion;
	};
	readonly code: TrajectoryCode;
	readonly context?: TrajectoryContext;
	readonly spans: readonly TrajectorySpan[];
	readonly payloads: Record<string, TrajectoryPayload>;
	readonly scores?: readonly Score[];
	readonly feedback?: readonly Feedback[];
	/** Whole-trajectory usage rollup (see aggregateTrajectoryUsage). */
	readonly usage?: Usage & { readonly costUsd?: number; readonly latencyMs?: number };
}

export interface ValidationResult<T> {
	readonly ok: boolean;
	readonly errors: readonly string[];
	readonly value: T | null;
}

export function hashTrajectory(trajectory: Trajectory): string {
	return `sha256:${createHash("sha256").update(canonicalJson(trajectory)).digest("hex")}`;
}

/** Infers a Score's dataType from its value. */
export function scoreDataType(score: Pick<Score, "value" | "dataType">): "numeric" | "categorical" | "boolean" {
	if (score.dataType) {
		return score.dataType;
	}
	if (typeof score.value === "number") {
		return "numeric";
	}
	if (typeof score.value === "boolean") {
		return "boolean";
	}
	return "categorical";
}

export function validateScore(score: unknown, errors: string[], pathName: string): void {
	if (!isRecord(score)) {
		errors.push(`${pathName} must be an object`);
		return;
	}
	if (!isNonEmptyString(score["name"])) {
		errors.push(`${pathName}.name must be a non-empty string`);
	}
	const value = score["value"];
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			errors.push(`${pathName}.value must be finite`);
		}
	} else if (typeof value !== "string" && typeof value !== "boolean") {
		errors.push(`${pathName}.value must be a number, string, or boolean`);
	}
	if (!isNonEmptyString(score["source"])) {
		errors.push(`${pathName}.source must be a non-empty string`);
	}
	const dataType = score["dataType"];
	if (dataType !== undefined && (typeof dataType !== "string" || !SCORE_DATA_TYPES.has(dataType))) {
		errors.push(`${pathName}.dataType must be numeric, categorical, or boolean`);
	}
}

export function validateFeedbackList(feedback: unknown, errors: string[], pathName: string): void {
	if (!Array.isArray(feedback)) {
		errors.push(`${pathName} must be an array`);
		return;
	}
	for (const [index, item] of feedback.entries()) {
		if (!isRecord(item)) {
			errors.push(`${pathName}.${index} must be an object`);
			continue;
		}
		if (item["kind"] === "score") {
			const score = item["score"];
			if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
				errors.push(`${pathName}.${index}.score must be between 0 and 1`);
			}
		} else if (item["kind"] === "text") {
			if (!isNonEmptyString(item["text"])) {
				errors.push(`${pathName}.${index}.text must be a non-empty string`);
			}
		} else if (item["kind"] === "error") {
			if (!isNonEmptyString(item["message"])) {
				errors.push(`${pathName}.${index}.message must be a non-empty string`);
			}
		} else {
			errors.push(`${pathName}.${index}.kind must be score, text, or error`);
		}
	}
}

export function validateTrajectory(trajectory: unknown): ValidationResult<Trajectory> {
	const errors: string[] = [];

	if (!isRecord(trajectory)) {
		return { ok: false, errors: ["trajectory must be an object"], value: null };
	}
	if (trajectory["schema"] !== TRAJECTORY_SCHEMA) {
		errors.push(`trajectory.schema must be ${TRAJECTORY_SCHEMA}`);
	}
	if (!isNonEmptyString(trajectory["id"])) {
		errors.push("trajectory.id must be a non-empty string");
	}
	if (!TRACEPARENT_PATTERN.test(String(trajectory["traceparent"] ?? ""))) {
		errors.push("trajectory.traceparent must be W3C traceparent");
	}

	validateRunCorrelation(trajectory["run"], errors);
	const subject = trajectory["subject"];
	if (!isRecord(subject)) {
		errors.push("trajectory.subject must be an object");
	} else {
		if (!isNonEmptyString(subject["method"])) {
			errors.push("trajectory.subject.method must be a non-empty string");
		}
		if (!isNonEmptyString(subject["contractRef"])) {
			errors.push("trajectory.subject.contractRef must be a non-empty string");
		}
		validateGeneratedRegionShape(subject["generatedRegion"], errors, "trajectory.subject.generatedRegion");
	}
	validateCode(trajectory["code"], errors);
	if (trajectory["context"] !== undefined) {
		validateContext(trajectory["context"], errors);
	}
	validateSpans(trajectory["spans"], errors);

	const scores = trajectory["scores"];
	const feedback = trajectory["feedback"];
	const hasScores = Array.isArray(scores) && scores.length > 0;
	const hasFeedback = Array.isArray(feedback) && feedback.length > 0;
	if (!hasScores && !hasFeedback) {
		errors.push("trajectory must carry at least one score or feedback item");
	}
	if (scores !== undefined) {
		if (!Array.isArray(scores)) {
			errors.push("trajectory.scores must be an array");
		} else {
			scores.forEach((score, index) => validateScore(score, errors, `trajectory.scores.${index}`));
		}
	}
	if (feedback !== undefined) {
		validateFeedbackList(feedback, errors, "trajectory.feedback");
	}

	const runId = isRecord(trajectory["run"]) ? trajectory["run"]["id"] : undefined;
	validatePayloads(trajectory["payloads"], typeof runId === "string" ? runId : "", errors);

	return {
		ok: errors.length === 0,
		errors,
		value: errors.length === 0 ? (structuredClone(trajectory) as unknown as Trajectory) : null,
	};
}

export function validateGeneratedRegionShape(region: unknown, errors: string[], pathName: string): void {
	if (!isRecord(region)) {
		errors.push(`${pathName} must be an object`);
		return;
	}
	if (!isNonEmptyString(region["regionId"])) {
		errors.push(`${pathName}.regionId must be a non-empty string`);
	}
	if (!isNonEmptyString(region["artifactRef"])) {
		errors.push(`${pathName}.artifactRef must be a non-empty string`);
	}
	const startOffset = region["startOffset"];
	const endOffset = region["endOffset"];
	if (!Number.isInteger(startOffset) || (startOffset as number) < 0) {
		errors.push(`${pathName}.startOffset must be a non-negative integer`);
	}
	if (!Number.isInteger(endOffset) || (endOffset as number) <= (startOffset as number)) {
		errors.push(`${pathName}.endOffset must be greater than startOffset`);
	}
	if (!isNonEmptyString(region["owner"])) {
		errors.push(`${pathName}.owner must be a non-empty string`);
	}
}

function validateCode(code: unknown, errors: string[]): void {
	if (!isRecord(code)) {
		errors.push("trajectory.code must be an object (regionDigest is required for training attribution)");
		return;
	}
	if (!/^sha256:[a-f0-9]{64}$/.test(String(code["regionDigest"] ?? ""))) {
		errors.push("trajectory.code.regionDigest must be a sha256 digest of the region body");
	}
	const arm = code["arm"];
	if (arm !== undefined && (typeof arm !== "string" || !TRAJECTORY_ARMS.has(arm))) {
		errors.push("trajectory.code.arm must be champion, challenger, or shadow");
	}
}

function validateContext(context: unknown, errors: string[]): void {
	if (!isRecord(context)) {
		errors.push("trajectory.context must be an object");
		return;
	}
	const session = context["session"];
	if (session !== undefined && (!isRecord(session) || !isNonEmptyString(session["id"]))) {
		errors.push("trajectory.context.session.id must be a non-empty string");
	}
	const user = context["user"];
	if (user !== undefined && (!isRecord(user) || !isNonEmptyString(user["id"]))) {
		errors.push("trajectory.context.user.id must be a non-empty string");
	}
	const tags = context["tags"];
	if (tags !== undefined && (!Array.isArray(tags) || tags.some((tag) => !isNonEmptyString(tag)))) {
		errors.push("trajectory.context.tags must be an array of non-empty strings");
	}
}

function validateRunCorrelation(run: unknown, errors: string[]): void {
	if (!isRecord(run)) {
		errors.push("trajectory.run must be an object");
		return;
	}
	if (!isNonEmptyString(run["id"])) {
		errors.push("trajectory.run.id must be a non-empty string");
	}
	const agent = run["agent"];
	if (agent !== undefined) {
		if (!isRecord(agent)) {
			errors.push("trajectory.run.agent must be an object");
			return;
		}
		if (!isNonEmptyString(agent["id"])) {
			errors.push("trajectory.run.agent.id must be a non-empty string");
		}
		if (!isNonEmptyString(agent["principalRef"])) {
			errors.push("trajectory.run.agent.principalRef must be a non-empty string");
		}
	}
}

function validateSpans(spans: unknown, errors: string[]): void {
	if (!Array.isArray(spans) || spans.length === 0) {
		errors.push("trajectory.spans must be a non-empty array");
		return;
	}

	const spanIds = new Set<string>();
	let rootCount = 0;
	for (const [index, span] of spans.entries()) {
		if (!isRecord(span)) {
			errors.push(`spans.${index} must be an object`);
			continue;
		}
		if (!isNonEmptyString(span["parentId"])) {
			rootCount += 1;
		}
		const id = span["id"];
		if (!isNonEmptyString(id)) {
			errors.push(`spans.${index}.id must be a non-empty string`);
		} else if (spanIds.has(id)) {
			errors.push(`spans.${index}.id must be unique`);
		} else {
			spanIds.add(id);
		}
		const attributes = span["attributes"];
		if (!isRecord(attributes)) {
			errors.push(`spans.${index}.attributes must be an object`);
			continue;
		}
		const kind = attributes["openinference.span.kind"];
		if (typeof kind !== "string" || !OPENINFERENCE_SPAN_KINDS.has(kind)) {
			errors.push(`spans.${index}.attributes.openinference.span.kind must be an OpenInference span kind`);
		}
		const status = span["status"];
		if (status !== undefined) {
			if (!isRecord(status) || typeof status["code"] !== "string" || !SPAN_STATUS_CODES.has(status["code"])) {
				errors.push(`spans.${index}.status.code must be OK, ERROR, or UNSET`);
			}
		}
		validateGenAi(span["genAi"], kind === "LLM", errors, `spans.${index}.genAi`);
	}

	for (const [index, span] of spans.entries()) {
		const parentId = isRecord(span) ? span["parentId"] : undefined;
		if (isNonEmptyString(parentId) && !spanIds.has(parentId)) {
			errors.push(`spans.${index}.parentId must reference another span`);
		}
	}

	// OTLP export binds trajectory-level attributes and score/feedback events
	// to THE root span, so a trajectory must have exactly one.
	if (rootCount !== 1) {
		errors.push("trajectory.spans must contain exactly one root span");
	}
}

function validateGenAi(genAi: unknown, isLlmSpan: boolean, errors: string[], pathName: string): void {
	if (genAi === undefined) {
		if (isLlmSpan) {
			errors.push(`${pathName} is required on LLM spans (requestModel and usage)`);
		}
		return;
	}
	if (!isRecord(genAi)) {
		errors.push(`${pathName} must be an object`);
		return;
	}
	if (isLlmSpan) {
		if (!isNonEmptyString(genAi["requestModel"])) {
			errors.push(`${pathName}.requestModel is required on LLM spans`);
		}
		if (genAi["usage"] === undefined) {
			errors.push(`${pathName}.usage is required on LLM spans`);
		}
	}
	const usage = genAi["usage"];
	if (usage !== undefined) {
		validateUsage(usage, errors, `${pathName}.usage`);
	}
	for (const key of ["inputMessages", "outputMessages"] as const) {
		const messages = genAi[key];
		if (messages === undefined) {
			continue;
		}
		if (!Array.isArray(messages)) {
			errors.push(`${pathName}.${key} must be an array`);
			continue;
		}
		messages.forEach((message, index) => {
			if (!isRecord(message) || typeof message["role"] !== "string" || !MESSAGE_ROLES.has(message["role"])) {
				errors.push(`${pathName}.${key}.${index}.role must be system, user, assistant, or tool`);
			}
		});
	}
}

export function validateUsage(usage: unknown, errors: string[], pathName: string): void {
	if (!isRecord(usage)) {
		errors.push(`${pathName} must be an object`);
		return;
	}
	for (const key of ["inputTokens", "outputTokens"] as const) {
		const value = usage[key];
		if (!Number.isInteger(value) || (value as number) < 0) {
			errors.push(`${pathName}.${key} must be a non-negative integer`);
		}
	}
}

function validatePayloads(payloads: unknown, runId: string, errors: string[]): void {
	if (!isRecord(payloads)) {
		errors.push("trajectory.payloads must be an object");
		return;
	}

	for (const [name, payload] of Object.entries(payloads)) {
		if (!isRecord(payload)) {
			errors.push(`payload ${name} must be an object`);
			continue;
		}
		const classification = payload["classification"] ?? "public";
		if (typeof classification !== "string" || !SENSITIVE_CLASSIFICATIONS.has(classification)) {
			continue;
		}
		if (payload["redaction"] === "tokenized" && isNonEmptyString(payload["tokenRef"])) {
			if (isNonEmptyString(payload["value"])) {
				errors.push(`sensitive payload ${name} must not retain a raw value alongside tokenRef`);
			}
			continue;
		}
		const encryptedRef = payload["encryptedRef"];
		if (
			payload["redaction"] === "encrypted" &&
			isNonEmptyString(encryptedRef) &&
			encryptedRef.startsWith(`run://${runId}/`)
		) {
			if (isNonEmptyString(payload["value"])) {
				errors.push(`sensitive payload ${name} must not retain a raw value alongside encryptedRef`);
			}
			continue;
		}
		errors.push(`sensitive payload ${name} must be tokenized or encrypted`);
	}
}

/**
 * Rolls a trajectory's per-span genAi usage/cost into the trajectory-level
 * usage summary; latency comes from the root span's start/end times.
 */
export function aggregateTrajectoryUsage(
	trajectory: Trajectory,
): (Usage & { costUsd?: number; latencyMs?: number }) | undefined {
	let inputTokens = 0;
	let outputTokens = 0;
	let costUsd = 0;
	let sawUsage = false;
	let sawCost = false;

	for (const span of trajectory.spans) {
		const usage = span.genAi?.usage;
		if (usage) {
			sawUsage = true;
			inputTokens += usage.inputTokens;
			outputTokens += usage.outputTokens;
		}
		const cost = span.genAi?.cost;
		if (cost?.totalUsd !== undefined) {
			sawCost = true;
			costUsd += cost.totalUsd;
		}
	}

	const root = trajectory.spans.find((span) => !span.parentId);
	const latencyMs =
		root?.startTime && root?.endTime ? Date.parse(root.endTime) - Date.parse(root.startTime) : undefined;

	if (!sawUsage && !sawCost && latencyMs === undefined) {
		return undefined;
	}
	return {
		inputTokens,
		outputTokens,
		totalTokens: inputTokens + outputTokens,
		...(sawCost ? { costUsd } : {}),
		...(latencyMs === undefined || Number.isNaN(latencyMs) ? {} : { latencyMs }),
	};
}
