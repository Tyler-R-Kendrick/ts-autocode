import { isNonEmptyString, isRecord } from "./canonical.js";
import {
	AUTOCODE_ATTR,
	contextFromConventionAttributes,
	fromConventionAttributes,
} from "./conventions.js";
import { fromKeyValues, fromUnixNano } from "./otlp.js";
import type { GeneratedRegion } from "./region.js";
import {
	type Feedback,
	type Score,
	type SpanStatus,
	TRAJECTORY_SCHEMA,
	type Trajectory,
	type TrajectoryCode,
	type TrajectoryPayload,
	type TrajectoryRun,
	type TrajectorySpan,
	aggregateTrajectoryUsage,
	validateTrajectory,
} from "./trajectory.js";

// Ingest: build trajectories from OTLP/JSON trace data — either our own
// export (round-trip via autocode.* binding attributes) or foreign
// instrumentation (OTel gen_ai.* / OpenInference llm.*), in which case the
// caller supplies the binding through `bind`. Unmappable traces are
// reported, never silently dropped.

const STATUS_FROM_CODE: Record<number, SpanStatus["code"]> = { 0: "UNSET", 1: "OK", 2: "ERROR" };

interface RawSpan {
	readonly traceId: string;
	readonly spanId: string;
	readonly parentSpanId?: string;
	readonly name: string;
	readonly startTimeUnixNano?: string;
	readonly endTimeUnixNano?: string;
	readonly attributes: Record<string, unknown>;
	readonly events: readonly { name: string; attributes: Record<string, unknown> }[];
	readonly status?: SpanStatus;
}

/** The binding a foreign trace needs before it can become a trajectory. */
export interface IngestBinding {
	readonly run: TrajectoryRun & { readonly traceparent?: string };
	readonly subject: {
		readonly method: string;
		readonly contractRef: string;
		readonly generatedRegion: GeneratedRegion;
	};
	readonly code: TrajectoryCode;
	readonly scores?: readonly Score[];
	readonly feedback?: readonly Feedback[];
}

export interface FromOtelSpansOptions {
	/**
	 * Supplies run/subject/code binding for traces without autocode.*
	 * attributes (foreign instrumentation). Receives the root span's
	 * attributes and all spans of the trace; return undefined to skip.
	 */
	readonly bind?: (rootAttributes: Record<string, unknown>, spans: readonly RawSpan[]) => IngestBinding | undefined;
}

export interface FromOtelSpansResult {
	readonly trajectories: readonly Trajectory[];
	readonly skipped: readonly { traceId: string; reason: string }[];
}

/**
 * Builds trajectories from OTLP/JSON (the object shape toOtlpJson emits, or
 * anything structurally equivalent from another OTel SDK/collector).
 */
export function fromOtelSpans(otlpJson: unknown, { bind }: FromOtelSpansOptions = {}): FromOtelSpansResult {
	const rawSpans = collectSpans(otlpJson);
	const byTrace = new Map<string, RawSpan[]>();
	for (const span of rawSpans) {
		const group = byTrace.get(span.traceId) ?? [];
		group.push(span);
		byTrace.set(span.traceId, group);
	}

	const trajectories: Trajectory[] = [];
	const skipped: { traceId: string; reason: string }[] = [];

	for (const [traceId, spans] of byTrace) {
		const spanIds = new Set(spans.map((span) => span.spanId));
		const root = spans.find((span) => !isNonEmptyString(span.parentSpanId) || !spanIds.has(span.parentSpanId));
		if (!root) {
			skipped.push({ traceId, reason: "no root span" });
			continue;
		}

		const binding = bindingFromAttributes(root) ?? bind?.(root.attributes, spans);
		if (!binding) {
			skipped.push({ traceId, reason: "no autocode.* binding attributes and no bind() result" });
			continue;
		}

		const trajectorySpans = orderSpans(spans, root).map((span) => toTrajectorySpan(span));
		const payloads = payloadsFromAttributes(root.attributes, binding.run.id);
		const scores = binding.scores ?? scoresFromEvents(root);
		const feedback = binding.feedback ?? feedbackFromEvents(root);
		const traceparent =
			binding.run.traceparent ??
			stringAttr(root.attributes, AUTOCODE_ATTR.traceparent) ??
			`00-${traceId}-${root.spanId}-01`;

		const { traceparent: _omitted, ...run } = binding.run;
		const context = contextFor(root);
		const base: Trajectory = {
			schema: TRAJECTORY_SCHEMA,
			id: stringAttr(root.attributes, AUTOCODE_ATTR.trajectoryId) ?? `trajectory-${traceId}`,
			traceparent,
			run,
			subject: structuredClone(binding.subject),
			code: structuredClone(binding.code),
			...(context === undefined ? {} : { context }),
			spans: trajectorySpans,
			payloads,
			...(scores.length > 0 ? { scores } : {}),
			...(scores.length === 0 || feedback.length > 0
				? { feedback: feedback.length > 0 ? feedback : [{ kind: "text", text: "ingested without signal" }] }
				: {}),
		};
		const usage = aggregateTrajectoryUsage(base);
		const trajectory = usage === undefined ? base : { ...base, usage };

		const validation = validateTrajectory(trajectory);
		if (!validation.ok) {
			skipped.push({ traceId, reason: `invalid trajectory: ${validation.errors.join("; ")}` });
			continue;
		}
		trajectories.push(trajectory);
	}

	return { trajectories, skipped };
}

function collectSpans(otlpJson: unknown): RawSpan[] {
	if (Array.isArray(otlpJson)) {
		return otlpJson.flatMap((entry) => normalizeSpan(entry) ?? []);
	}
	if (!isRecord(otlpJson) || !Array.isArray(otlpJson["resourceSpans"])) {
		return [];
	}
	const spans: RawSpan[] = [];
	for (const resourceSpan of otlpJson["resourceSpans"]) {
		if (!isRecord(resourceSpan) || !Array.isArray(resourceSpan["scopeSpans"])) {
			continue;
		}
		for (const scopeSpan of resourceSpan["scopeSpans"]) {
			if (!isRecord(scopeSpan) || !Array.isArray(scopeSpan["spans"])) {
				continue;
			}
			for (const span of scopeSpan["spans"]) {
				const normalized = normalizeSpan(span);
				if (normalized) {
					spans.push(normalized);
				}
			}
		}
	}
	return spans;
}

function normalizeSpan(span: unknown): RawSpan | undefined {
	if (!isRecord(span) || !isNonEmptyString(span["traceId"]) || !isNonEmptyString(span["spanId"])) {
		return undefined;
	}
	const statusRaw = span["status"];
	const statusCode = isRecord(statusRaw) ? STATUS_FROM_CODE[Number(statusRaw["code"])] : undefined;
	return {
		traceId: span["traceId"],
		spanId: span["spanId"],
		...(isNonEmptyString(span["parentSpanId"]) ? { parentSpanId: span["parentSpanId"] } : {}),
		name: isNonEmptyString(span["name"]) ? span["name"] : "span",
		...(isNonEmptyString(span["startTimeUnixNano"]) ? { startTimeUnixNano: span["startTimeUnixNano"] } : {}),
		...(isNonEmptyString(span["endTimeUnixNano"]) ? { endTimeUnixNano: span["endTimeUnixNano"] } : {}),
		attributes: fromKeyValues(span["attributes"]),
		events: Array.isArray(span["events"])
			? span["events"].flatMap((event) =>
					isRecord(event) && isNonEmptyString(event["name"])
						? [{ name: event["name"], attributes: fromKeyValues(event["attributes"]) }]
						: [],
				)
			: [],
		...(statusCode === undefined
			? {}
			: {
					status: {
						code: statusCode,
						...(isRecord(statusRaw) && isNonEmptyString(statusRaw["message"])
							? { message: statusRaw["message"] }
							: {}),
					},
				}),
	};
}

function orderSpans(spans: readonly RawSpan[], root: RawSpan): RawSpan[] {
	return [root, ...spans.filter((span) => span !== root)];
}

function toTrajectorySpan(span: RawSpan): TrajectorySpan {
	const genAi = fromConventionAttributes(span.attributes);
	const kind = span.attributes["openinference.span.kind"];
	return {
		id: span.spanId,
		parentId: span.parentSpanId ?? null,
		traceId: span.traceId,
		name: span.name,
		...(span.startTimeUnixNano === undefined ? {} : { startTime: fromUnixNano(span.startTimeUnixNano) }),
		...(span.endTimeUnixNano === undefined ? {} : { endTime: fromUnixNano(span.endTimeUnixNano) }),
		...(span.status === undefined ? {} : { status: span.status }),
		attributes: {
			...span.attributes,
			// Kind is required by the trajectory schema; foreign spans without
			// it default by heuristic: model call → LLM, else CHAIN.
			"openinference.span.kind":
				typeof kind === "string" ? kind : genAi?.requestModel !== undefined ? "LLM" : "CHAIN",
		},
		...(genAi === undefined ? {} : { genAi }),
	};
}

function bindingFromAttributes(root: RawSpan): IngestBinding | undefined {
	const attributes = root.attributes;
	const runId = stringAttr(attributes, AUTOCODE_ATTR.runId);
	const method = stringAttr(attributes, AUTOCODE_ATTR.method);
	const contractRef = stringAttr(attributes, AUTOCODE_ATTR.contractRef);
	const regionId = stringAttr(attributes, AUTOCODE_ATTR.regionId);
	const regionDigest = stringAttr(attributes, AUTOCODE_ATTR.regionDigest);
	if (!runId || !method || !contractRef || !regionId || !regionDigest) {
		return undefined;
	}

	const tenantId = stringAttr(attributes, AUTOCODE_ATTR.tenantId);
	const agentId = stringAttr(attributes, AUTOCODE_ATTR.agentId);
	const agentPrincipalRef = stringAttr(attributes, AUTOCODE_ATTR.agentPrincipalRef);
	const candidateId = stringAttr(attributes, AUTOCODE_ATTR.candidateId);
	const arm = stringAttr(attributes, AUTOCODE_ATTR.arm) as TrajectoryCode["arm"] | undefined;

	return {
		run: {
			id: runId,
			...(tenantId === undefined ? {} : { tenantId }),
			...(agentId !== undefined && agentPrincipalRef !== undefined
				? { agent: { id: agentId, principalRef: agentPrincipalRef } }
				: {}),
		},
		subject: {
			method,
			contractRef,
			generatedRegion: {
				regionId,
				artifactRef: stringAttr(attributes, AUTOCODE_ATTR.regionArtifactRef) ?? "artifact://unknown",
				startOffset: numberAttr(attributes, AUTOCODE_ATTR.regionStartOffset) ?? 0,
				endOffset: numberAttr(attributes, AUTOCODE_ATTR.regionEndOffset) ?? 1,
				owner: stringAttr(attributes, AUTOCODE_ATTR.regionOwner) ?? "training-engine",
			},
		},
		code: {
			regionDigest,
			...(candidateId === undefined ? {} : { candidateId }),
			...(arm === undefined ? {} : { arm }),
		},
	};
}

function contextFor(root: RawSpan) {
	return contextFromConventionAttributes(root.attributes);
}

function payloadsFromAttributes(attributes: Record<string, unknown>, runId: string): Record<string, TrajectoryPayload> {
	const payloads: Record<string, TrajectoryPayload> = {};
	for (const [key, value] of Object.entries(attributes)) {
		if (key.startsWith(AUTOCODE_ATTR.payloadPrefix) && typeof value === "string") {
			payloads[key.slice(AUTOCODE_ATTR.payloadPrefix.length)] = {
				classification: "public",
				redaction: "none",
				value,
			};
		} else if (key.startsWith(AUTOCODE_ATTR.payloadRefPrefix) && typeof value === "string") {
			const name = key.slice(AUTOCODE_ATTR.payloadRefPrefix.length);
			payloads[name] = value.startsWith(`run://${runId}/`)
				? { classification: "pii", redaction: "encrypted", encryptedRef: value }
				: { classification: "pii", redaction: "tokenized", tokenRef: value };
		}
	}
	return payloads;
}

function scoresFromEvents(root: RawSpan): Score[] {
	const scores: Score[] = [];
	for (const event of root.events) {
		if (event.name !== AUTOCODE_ATTR.scoreEventName) {
			continue;
		}
		const name = stringAttr(event.attributes, "name");
		const source = stringAttr(event.attributes, "source");
		const value = event.attributes["value"];
		if (!name || !source || (typeof value !== "number" && typeof value !== "string" && typeof value !== "boolean")) {
			continue;
		}
		const dataType = stringAttr(event.attributes, "dataType") as Score["dataType"] | undefined;
		const rubricRef = stringAttr(event.attributes, "rubricRef");
		const comment = stringAttr(event.attributes, "comment");
		const eventId = stringAttr(event.attributes, "eventId");
		const observedAt = stringAttr(event.attributes, "observedAt");
		scores.push({
			name,
			value,
			source,
			...(dataType === undefined ? {} : { dataType }),
			...(rubricRef === undefined ? {} : { rubricRef }),
			...(comment === undefined ? {} : { comment }),
			...(eventId === undefined ? {} : { eventId }),
			...(observedAt === undefined ? {} : { observedAt }),
		});
	}
	return scores;
}

function feedbackFromEvents(root: RawSpan): Feedback[] {
	const feedback: Feedback[] = [];
	for (const event of root.events) {
		if (event.name !== AUTOCODE_ATTR.feedbackEventName) {
			continue;
		}
		const kind = stringAttr(event.attributes, "kind");
		if (kind === "score" && typeof event.attributes["score"] === "number") {
			feedback.push({ kind: "score", score: event.attributes["score"] });
		} else if (kind === "text") {
			const text = stringAttr(event.attributes, "text");
			if (text !== undefined) {
				feedback.push({ kind: "text", text });
			}
		} else if (kind === "error") {
			const message = stringAttr(event.attributes, "message");
			const detail = stringAttr(event.attributes, "detail");
			if (message !== undefined) {
				feedback.push({ kind: "error", message, ...(detail === undefined ? {} : { detail }) });
			}
		}
	}
	return feedback;
}

function stringAttr(attributes: Record<string, unknown>, key: string): string | undefined {
	const value = attributes[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberAttr(attributes: Record<string, unknown>, key: string): number | undefined {
	const value = attributes[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
