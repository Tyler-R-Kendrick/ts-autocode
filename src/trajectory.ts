import { createHash } from "node:crypto";

import { canonicalJson, isNonEmptyString, isRecord } from "./canonical.js";
import type { GeneratedRegion } from "./region.js";

export const TRAJECTORY_SCHEMA = "ts-autocode.training.trajectory/v1";

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

export interface TrajectorySpan {
	readonly id: string;
	readonly parentId?: string | null;
	readonly name: string;
	readonly startTime?: string;
	readonly endTime?: string;
	/** Must include `openinference.span.kind`. */
	readonly attributes: Record<string, unknown>;
	readonly inputs?: Record<string, unknown>;
	readonly outputs?: Record<string, unknown>;
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

export interface TrajectoryReward {
	/** Where the reward came from (e.g. "live-eval", "held-out", "human-label"). */
	readonly source: string;
	readonly rubricRef: string;
	readonly eventId?: string;
	/** Normalized to [0, 1]. */
	readonly score: number;
	readonly observedAt?: string;
}

export interface TrajectoryRun {
	readonly id: string;
	readonly tenantId?: string;
	readonly agent?: {
		readonly id: string;
		readonly principalRef: string;
	};
}

/**
 * One observed execution of an optimizable method: correlated spans, the
 * generated region it exercised, redaction-governed payloads, and the reward
 * signal the optimizer learns from.
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
	readonly spans: readonly TrajectorySpan[];
	readonly payloads: Record<string, TrajectoryPayload>;
	readonly reward: TrajectoryReward;
}

export interface ValidationResult<T> {
	readonly ok: boolean;
	readonly errors: readonly string[];
	readonly value: T | null;
}

export function hashTrajectory(trajectory: Trajectory): string {
	return `sha256:${createHash("sha256").update(canonicalJson(trajectory)).digest("hex")}`;
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
	validateSpans(trajectory["spans"], errors);
	validateReward(trajectory["reward"], errors);
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

export function validateReward(reward: unknown, errors: string[]): void {
	if (!isRecord(reward)) {
		errors.push("trajectory.reward must be an object");
		return;
	}
	const score = reward["score"];
	if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
		errors.push("trajectory.reward.score must be between 0 and 1");
	}
	if (!isNonEmptyString(reward["rubricRef"])) {
		errors.push("trajectory.reward.rubricRef must be a non-empty string");
	}
	if (!isNonEmptyString(reward["source"])) {
		errors.push("trajectory.reward.source must be a non-empty string");
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
	for (const [index, span] of spans.entries()) {
		if (!isRecord(span)) {
			errors.push(`spans.${index} must be an object`);
			continue;
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
	}

	for (const [index, span] of spans.entries()) {
		const parentId = isRecord(span) ? span["parentId"] : undefined;
		if (isNonEmptyString(parentId) && !spanIds.has(parentId)) {
			errors.push(`spans.${index}.parentId must reference another span`);
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
			continue;
		}
		const encryptedRef = payload["encryptedRef"];
		if (
			payload["redaction"] === "encrypted" &&
			isNonEmptyString(encryptedRef) &&
			encryptedRef.startsWith(`run://${runId}/`)
		) {
			continue;
		}
		errors.push(`sensitive payload ${name} must be tokenized or encrypted`);
	}
}
