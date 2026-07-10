import { createHash } from "node:crypto";

import { isNonEmptyString, isRecord } from "./canonical.js";
import { validateCandidatePatch } from "./engine.js";
import {
	TRACEPARENT_PATTERN,
	type ValidationResult,
	hashTrajectory,
	validateReward,
	validateTrajectory,
} from "./trajectory.js";
import type { Trajectory } from "./trajectory.js";
import type { CandidatePatch } from "./engine.js";

export const TELEMETRY_ENVELOPE_SCHEMA = "ts-autocode.telemetry-envelope/v1";
export const TRAINING_EVENT_SCHEMA = "ts-autocode.training.event/v1";

/**
 * The training-run event vocabulary. Every step of the loop is an appended
 * fact, so a run can be audited and replayed from its log alone.
 */
export const TRAINING_EVENT_TYPES = Object.freeze([
	"training.RunStarted",
	"training.TrajectoryCaptured",
	"training.RewardObserved",
	"training.CandidateProposed",
	"training.CandidateEvaluated",
	"training.Promoted",
	"training.Rejected",
] as const);

export type TrainingEventType = (typeof TRAINING_EVENT_TYPES)[number];

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

export interface TrainingEvent {
	readonly schema: typeof TELEMETRY_ENVELOPE_SCHEMA;
	readonly id: string;
	readonly type: TrainingEventType;
	readonly source: string;
	readonly subject: string;
	readonly streamId: string;
	readonly seq: number;
	readonly time: string;
	readonly meta: { readonly traceparent: string };
	readonly data: { readonly schema: typeof TRAINING_EVENT_SCHEMA; readonly runId: string } & Record<string, unknown>;
}

export interface CreateTrainingEventInput {
	readonly id: string;
	readonly type: TrainingEventType;
	readonly runId: string;
	readonly seq: number;
	readonly time?: string;
	readonly source?: string;
	readonly traceparent?: string;
	readonly data?: Record<string, unknown>;
}

/**
 * Builds a well-formed training event envelope. Defaults are deterministic
 * (epoch time, a traceparent derived from the runId) so replay digests stay
 * byte-stable; pass real values in live systems.
 */
export function createTrainingEvent({
	id,
	type,
	runId,
	seq,
	time = "1970-01-01T00:00:00.000Z",
	source = "ts-autocode://training",
	traceparent = deriveTraceparent(runId),
	data = {},
}: CreateTrainingEventInput): TrainingEvent {
	return {
		schema: TELEMETRY_ENVELOPE_SCHEMA,
		id,
		type,
		source,
		subject: `training/${runId}`,
		streamId: `training:${runId}`,
		seq,
		time,
		meta: { traceparent },
		data: {
			schema: TRAINING_EVENT_SCHEMA,
			runId,
			...(structuredClone(data) as Record<string, unknown>),
		},
	};
}

export function validateTrainingEvent(event: unknown): ValidationResult<TrainingEvent> {
	const errors: string[] = [];

	if (!isRecord(event)) {
		return { ok: false, errors: ["event must be an object"], value: null };
	}
	if (event["schema"] !== TELEMETRY_ENVELOPE_SCHEMA) {
		errors.push(`event.schema must be ${TELEMETRY_ENVELOPE_SCHEMA}`);
	}
	if (!isNonEmptyString(event["id"])) {
		errors.push("event.id must be a non-empty string");
	}
	if (!TRAINING_EVENT_TYPES.includes(event["type"] as TrainingEventType)) {
		errors.push(`event.type must be one of ${TRAINING_EVENT_TYPES.join(", ")}`);
	}
	const seq = event["seq"];
	if (!Number.isInteger(seq) || (seq as number) < 0) {
		errors.push("event.seq must be a non-negative integer");
	}
	const data = event["data"];
	if (!isRecord(data)) {
		errors.push("event.data must be an object");
	} else {
		if (data["schema"] !== TRAINING_EVENT_SCHEMA) {
			errors.push(`event.data.schema must be ${TRAINING_EVENT_SCHEMA}`);
		}
		if (!isNonEmptyString(data["runId"])) {
			errors.push("event.data.runId must be a non-empty string");
		}
	}
	const meta = event["meta"];
	if (!isRecord(meta) || !TRACEPARENT_PATTERN.test(String(meta["traceparent"] ?? ""))) {
		errors.push("event.meta.traceparent must be W3C traceparent");
	}
	const runId = isRecord(data) ? data["runId"] : undefined;
	if (isNonEmptyString(runId) && event["subject"] !== `training/${runId}`) {
		errors.push("event.subject must correlate to event.data.runId");
	}
	if (isNonEmptyString(runId) && event["streamId"] !== `training:${runId}`) {
		errors.push("event.streamId must correlate to event.data.runId");
	}

	validateTrainingEventPayload(event, errors);

	return {
		ok: errors.length === 0,
		errors,
		value: errors.length === 0 ? (structuredClone(event) as unknown as TrainingEvent) : null,
	};
}

export interface TrainingRunProjection {
	runId: string | null;
	status: "unknown" | "running" | "promoted" | "rejected";
	trajectoryIds: string[];
	rewardCount: number;
	candidateIds: string[];
	lastSeq: number;
}

/**
 * Rebuilds the run's state purely from its event log — the materialized-view
 * side of the loop. Throws on the first invalid event: a log that does not
 * validate must not silently project.
 */
export function replayTrainingRun(events: readonly TrainingEvent[]): TrainingRunProjection {
	const sorted = [...events].sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
	const projection: TrainingRunProjection = {
		runId: null,
		status: "unknown",
		trajectoryIds: [],
		rewardCount: 0,
		candidateIds: [],
		lastSeq: -1,
	};

	for (const event of sorted) {
		const validation = validateTrainingEvent(event);
		if (!validation.ok) {
			throw new Error(`invalid training event ${event?.id ?? "unknown"}: ${validation.errors.join("; ")}`);
		}

		projection.runId ??= event.data.runId;
		projection.lastSeq = event.seq;

		if (event.type === "training.RunStarted") {
			projection.status = "running";
		} else if (event.type === "training.TrajectoryCaptured") {
			addUnique(projection.trajectoryIds, String(event.data["trajectoryId"]));
		} else if (event.type === "training.RewardObserved") {
			projection.rewardCount += 1;
		} else if (event.type === "training.CandidateProposed") {
			addUnique(projection.candidateIds, String((event.data["candidate"] as CandidatePatch).id));
		} else if (event.type === "training.CandidateEvaluated") {
			addUnique(projection.candidateIds, String(event.data["candidateId"]));
		} else if (event.type === "training.Promoted") {
			addUnique(projection.candidateIds, String(event.data["candidateId"]));
			projection.status = "promoted";
		} else if (event.type === "training.Rejected") {
			addUnique(projection.candidateIds, String(event.data["candidateId"]));
			projection.status = "rejected";
		}
	}

	return projection;
}

function validateTrainingEventPayload(event: Record<string, unknown>, errors: string[]): void {
	const data = event["data"];
	if (!isRecord(data)) {
		return;
	}

	const type = event["type"];
	if (type === "training.TrajectoryCaptured") {
		if (!isNonEmptyString(data["trajectoryId"])) {
			errors.push("TrajectoryCaptured.trajectoryId must be a non-empty string");
		}
		if (!HASH_PATTERN.test(String(data["trajectoryHash"] ?? ""))) {
			errors.push("TrajectoryCaptured.trajectoryHash must be sha256");
		}
		const trajectoryValidation = validateTrajectory(data["trajectory"]);
		if (!trajectoryValidation.ok) {
			errors.push(...trajectoryValidation.errors.map((error) => `TrajectoryCaptured.${error}`));
		} else if (data["trajectoryHash"] !== hashTrajectory(data["trajectory"] as Trajectory)) {
			errors.push("TrajectoryCaptured.trajectoryHash must match trajectory");
		}
	} else if (type === "training.RewardObserved") {
		if (!isNonEmptyString(data["trajectoryId"])) {
			errors.push("RewardObserved.trajectoryId must be a non-empty string");
		}
		validateReward(data["reward"], errors);
	} else if (type === "training.CandidateProposed") {
		const candidate = data["candidate"];
		const region = isRecord(candidate) ? candidate["region"] : undefined;
		const candidateValidation = validateCandidatePatch(
			candidate,
			isRecord(region) ? (region as never) : undefined,
		);
		if (!candidateValidation.ok) {
			errors.push(...candidateValidation.errors.map((error) => `CandidateProposed.${error}`));
		}
	} else if (type === "training.CandidateEvaluated") {
		if (!isNonEmptyString(data["candidateId"])) {
			errors.push("CandidateEvaluated.candidateId must be a non-empty string");
		}
		const conformance = data["conformance"];
		if (!isRecord(conformance) || typeof conformance["ok"] !== "boolean") {
			errors.push("CandidateEvaluated.conformance.ok must be boolean");
		}
	} else if (type === "training.Promoted") {
		if (!isNonEmptyString(data["candidateId"])) {
			errors.push("Promoted.candidateId must be a non-empty string");
		}
		if (!isNonEmptyString(data["promotionRef"])) {
			errors.push("Promoted.promotionRef must be a non-empty string");
		}
	} else if (type === "training.Rejected") {
		if (!isNonEmptyString(data["candidateId"])) {
			errors.push("Rejected.candidateId must be a non-empty string");
		}
		if (!isNonEmptyString(data["reason"])) {
			errors.push("Rejected.reason must be a non-empty string");
		}
	}
}

function deriveTraceparent(runId: string): string {
	const hash = createHash("sha256").update(runId).digest("hex");
	return `00-${hash.slice(0, 32)}-${hash.slice(32, 48)}-01`;
}

function addUnique(values: string[], value: string): void {
	if (!values.includes(value)) {
		values.push(value);
	}
}
