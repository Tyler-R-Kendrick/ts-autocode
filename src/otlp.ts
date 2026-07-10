import { isNonEmptyString, isRecord } from "./canonical.js";
import { AUTOCODE_ATTR, dualConventionAttributes } from "./conventions.js";
import type { Trajectory, TrajectorySpan } from "./trajectory.js";

// Zero-dependency OTLP/JSON export. Emits the standard OTLP trace shape
// (resourceSpans → scopeSpans → spans with KeyValue attribute lists) so any
// OTel collector — and OTLP-ingesting platforms like Langfuse or Arize
// Phoenix — can consume trajectories directly. Attributes carry BOTH the
// gen_ai.* and OpenInference vocabularies plus autocode.* binding
// attributes, which make the export round-trippable via fromOtelSpans.
//
// Raw sensitive payload values are NEVER exported — only their run-scoped
// refs; public payload values export as autocode.payload.<name>.

export interface OtlpKeyValue {
	readonly key: string;
	readonly value: OtlpAnyValue;
}

export type OtlpAnyValue =
	| { readonly stringValue: string }
	| { readonly intValue: string }
	| { readonly doubleValue: number }
	| { readonly boolValue: boolean }
	| { readonly arrayValue: { readonly values: readonly OtlpAnyValue[] } };

export interface OtlpSpanEvent {
	readonly name: string;
	readonly timeUnixNano: string;
	readonly attributes: readonly OtlpKeyValue[];
}

export interface OtlpSpan {
	readonly traceId: string;
	readonly spanId: string;
	readonly parentSpanId?: string;
	readonly name: string;
	readonly kind: number;
	readonly startTimeUnixNano: string;
	readonly endTimeUnixNano: string;
	readonly attributes: readonly OtlpKeyValue[];
	readonly events?: readonly OtlpSpanEvent[];
	readonly status?: { readonly code: number; readonly message?: string };
}

export interface OtlpJson {
	readonly resourceSpans: readonly {
		readonly resource: { readonly attributes: readonly OtlpKeyValue[] };
		readonly scopeSpans: readonly {
			readonly scope: { readonly name: string; readonly version?: string };
			readonly spans: readonly OtlpSpan[];
		}[];
	}[];
}

const SPAN_KIND_INTERNAL = 1;
const SPAN_KIND_CLIENT = 3;
const STATUS_CODE = { UNSET: 0, OK: 1, ERROR: 2 } as const;

export interface ToOtlpJsonOptions {
	/** Extra resource attributes (e.g. service.name). */
	readonly resource?: Record<string, unknown>;
	readonly scopeName?: string;
	readonly scopeVersion?: string;
}

/** Exports trajectories as OTLP/JSON trace data. */
export function toOtlpJson(
	trajectories: readonly Trajectory[],
	{ resource = {}, scopeName = "ts-autocode", scopeVersion }: ToOtlpJsonOptions = {},
): OtlpJson {
	const spans = trajectories.flatMap((trajectory) => trajectory.spans.map((span) => toOtlpSpan(trajectory, span)));
	return {
		resourceSpans: [
			{
				resource: {
					attributes: toKeyValues({ "service.name": "ts-autocode", ...resource }),
				},
				scopeSpans: [
					{
						scope: { name: scopeName, ...(scopeVersion === undefined ? {} : { version: scopeVersion }) },
						spans,
					},
				],
			},
		],
	};
}

function toOtlpSpan(trajectory: Trajectory, span: TrajectorySpan): OtlpSpan {
	const traceId = span.traceId ?? trajectory.traceparent.slice(3, 35);
	const isRoot = !isNonEmptyString(span.parentId);
	const kind = span.attributes["openinference.span.kind"];

	const attributes: Record<string, unknown> = {
		...span.attributes,
		...dualConventionAttributes(span, isRoot ? trajectory.context : undefined),
	};
	if (isRoot) {
		Object.assign(attributes, bindingAttributes(trajectory));
	}

	const scoreEvents: OtlpSpanEvent[] = isRoot
		? (trajectory.scores ?? []).map((score) => ({
				name: AUTOCODE_ATTR.scoreEventName,
				timeUnixNano: toUnixNano(score.observedAt ?? span.endTime ?? span.startTime),
				attributes: toKeyValues({
					name: score.name,
					value: score.value,
					source: score.source,
					...(score.dataType === undefined ? {} : { dataType: score.dataType }),
					...(score.rubricRef === undefined ? {} : { rubricRef: score.rubricRef }),
					...(score.comment === undefined ? {} : { comment: score.comment }),
					...(score.eventId === undefined ? {} : { eventId: score.eventId }),
					...(score.observedAt === undefined ? {} : { observedAt: score.observedAt }),
				}),
			}))
		: [];
	const feedbackEvents: OtlpSpanEvent[] = isRoot
		? (trajectory.feedback ?? []).map((item) => ({
				name: AUTOCODE_ATTR.feedbackEventName,
				timeUnixNano: toUnixNano(span.endTime ?? span.startTime),
				attributes: toKeyValues(item as unknown as Record<string, unknown>),
			}))
		: [];
	const events = [...scoreEvents, ...feedbackEvents];

	return {
		traceId,
		spanId: span.id,
		...(isNonEmptyString(span.parentId) ? { parentSpanId: span.parentId } : {}),
		name: span.name,
		kind: kind === "LLM" ? SPAN_KIND_CLIENT : SPAN_KIND_INTERNAL,
		startTimeUnixNano: toUnixNano(span.startTime),
		endTimeUnixNano: toUnixNano(span.endTime ?? span.startTime),
		attributes: toKeyValues(attributes),
		...(events.length > 0 ? { events } : {}),
		...(span.status === undefined
			? {}
			: {
					status: {
						code: STATUS_CODE[span.status.code],
						...(span.status.message === undefined ? {} : { message: span.status.message }),
					},
				}),
	};
}

function bindingAttributes(trajectory: Trajectory): Record<string, unknown> {
	const attributes: Record<string, unknown> = {
		[AUTOCODE_ATTR.trajectoryId]: trajectory.id,
		[AUTOCODE_ATTR.traceparent]: trajectory.traceparent,
		[AUTOCODE_ATTR.runId]: trajectory.run.id,
		[AUTOCODE_ATTR.method]: trajectory.subject.method,
		[AUTOCODE_ATTR.contractRef]: trajectory.subject.contractRef,
		[AUTOCODE_ATTR.regionId]: trajectory.subject.generatedRegion.regionId,
		[AUTOCODE_ATTR.regionArtifactRef]: trajectory.subject.generatedRegion.artifactRef,
		[AUTOCODE_ATTR.regionStartOffset]: trajectory.subject.generatedRegion.startOffset,
		[AUTOCODE_ATTR.regionEndOffset]: trajectory.subject.generatedRegion.endOffset,
		[AUTOCODE_ATTR.regionOwner]: trajectory.subject.generatedRegion.owner,
		[AUTOCODE_ATTR.regionDigest]: trajectory.code.regionDigest,
	};
	if (trajectory.run.tenantId !== undefined) {
		attributes[AUTOCODE_ATTR.tenantId] = trajectory.run.tenantId;
	}
	if (trajectory.run.agent !== undefined) {
		attributes[AUTOCODE_ATTR.agentId] = trajectory.run.agent.id;
		attributes[AUTOCODE_ATTR.agentPrincipalRef] = trajectory.run.agent.principalRef;
	}
	if (trajectory.code.candidateId !== undefined) {
		attributes[AUTOCODE_ATTR.candidateId] = trajectory.code.candidateId;
	}
	if (trajectory.code.arm !== undefined) {
		attributes[AUTOCODE_ATTR.arm] = trajectory.code.arm;
	}
	if (trajectory.context?.environment !== undefined) {
		attributes[AUTOCODE_ATTR.environment] = trajectory.context.environment;
	}
	if (trajectory.context?.release !== undefined) {
		attributes[AUTOCODE_ATTR.release] = trajectory.context.release;
	}
	for (const [name, payload] of Object.entries(trajectory.payloads)) {
		if (payload.classification === undefined || payload.classification === "public") {
			if (payload.value !== undefined) {
				attributes[`${AUTOCODE_ATTR.payloadPrefix}${name}`] = payload.value;
			}
			continue;
		}
		// Sensitive payloads export refs only, never raw values; the
		// classification rides along so ingest can restore it faithfully.
		const ref = payload.encryptedRef ?? payload.tokenRef;
		if (ref !== undefined) {
			attributes[`${AUTOCODE_ATTR.payloadRefPrefix}${name}`] = ref;
			attributes[`${AUTOCODE_ATTR.payloadClassPrefix}${name}`] = payload.classification;
		}
	}
	return attributes;
}

export function toKeyValues(record: Record<string, unknown>): OtlpKeyValue[] {
	return Object.entries(record)
		.filter(([, value]) => value !== undefined && value !== null)
		.map(([key, value]) => ({ key, value: toAnyValue(value) }));
}

export function toAnyValue(value: unknown): OtlpAnyValue {
	if (typeof value === "string") {
		return { stringValue: value };
	}
	if (typeof value === "boolean") {
		return { boolValue: value };
	}
	if (typeof value === "number") {
		return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
	}
	if (Array.isArray(value)) {
		return { arrayValue: { values: value.map(toAnyValue) } };
	}
	return { stringValue: JSON.stringify(value) };
}

export function fromAnyValue(value: unknown): unknown {
	if (!isRecord(value)) {
		return value;
	}
	if (typeof value["stringValue"] === "string") {
		return value["stringValue"];
	}
	if (value["intValue"] !== undefined) {
		return Number(value["intValue"]);
	}
	if (typeof value["doubleValue"] === "number") {
		return value["doubleValue"];
	}
	if (typeof value["boolValue"] === "boolean") {
		return value["boolValue"];
	}
	const arrayValue = value["arrayValue"];
	if (isRecord(arrayValue) && Array.isArray(arrayValue["values"])) {
		return arrayValue["values"].map(fromAnyValue);
	}
	return undefined;
}

export function fromKeyValues(attributes: unknown): Record<string, unknown> {
	if (!Array.isArray(attributes)) {
		return {};
	}
	const record: Record<string, unknown> = {};
	for (const entry of attributes) {
		if (isRecord(entry) && typeof entry["key"] === "string") {
			record[entry["key"]] = fromAnyValue(entry["value"]);
		}
	}
	return record;
}

function toUnixNano(isoTime: string | undefined): string {
	const ms = isoTime === undefined ? 0 : Date.parse(isoTime);
	return String(BigInt(Number.isNaN(ms) ? 0 : ms) * 1_000_000n);
}

/** Converts an OTLP nano timestamp back to ISO-8601 (millisecond precision). */
export function fromUnixNano(nano: string): string {
	return new Date(Number(BigInt(nano) / 1_000_000n)).toISOString();
}

export { SPAN_KIND_CLIENT, SPAN_KIND_INTERNAL, STATUS_CODE };
