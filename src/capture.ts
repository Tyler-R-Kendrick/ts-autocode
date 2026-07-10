import { createHash } from "node:crypto";

import { digest, isNonEmptyString, isRecord } from "./canonical.js";
import { dualConventionAttributes } from "./conventions.js";
import type { CandidatePatch } from "./engine.js";
import { type TrainingEvent, createTrainingEvent } from "./events.js";
import type { GeneratedRegion } from "./region.js";
import {
	type Feedback,
	type GenAiMessage,
	type GenAiSpanData,
	type Score,
	type SpanStatus,
	TRAJECTORY_SCHEMA,
	type Trajectory,
	type TrajectoryCode,
	type TrajectoryContext,
	type TrajectoryPayload,
	type TrajectorySpan,
	aggregateTrajectoryUsage,
	hashTrajectory,
	validateTrajectory,
} from "./trajectory.js";

export const CAPTURE_CONTRACT = "ts-autocode.trajectory-capture/v2";

const TRACEPARENT_CAPTURE_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

// The forward phase of the loop, Trace-style: wrap the optimizable call so
// every invocation records a trajectory (root CHAIN span + child spans) into
// an append-only event log. Trace builds its graph by tracing node
// operations at runtime; here the wrapped method IS the trainable node and
// its invocations are the trace oracle the optimizer consumes.
//
// Collection policy: capture a superset of what any single methodology needs
// today — model + params + usage + cost + messages (mode-gated), scores and
// feedback, session/user/tags/metadata, and the code version (region digest)
// that produced the run.

export interface CaptureRun {
	readonly id: string;
	readonly tenantId?: string;
	readonly agent?: { readonly id: string; readonly principalRef: string };
	/** W3C traceparent of the enclosing trace; the root span parents onto it. */
	readonly traceparent: string;
}

export interface CaptureMethod {
	readonly name: string;
	readonly contractRef: string;
	readonly generatedRegion: GeneratedRegion;
	/** sha256 digest of the region body being executed. Required unless regionSource is given. */
	readonly regionDigest?: string;
	/** The region body being executed; digested when regionDigest is absent. */
	readonly regionSource?: string;
	/** Candidate that produced the region body (challenger/shadow arms). */
	readonly candidateId?: string;
	readonly arm?: TrajectoryCode["arm"];
}

export interface CaptureChildSpan {
	readonly name: string;
	/** OpenInference span kind; defaults to LLM. */
	readonly kind?: string;
	readonly attributes?: Record<string, unknown>;
	readonly inputs?: Record<string, unknown>;
	readonly outputs?: Record<string, unknown>;
	readonly status?: SpanStatus;
	readonly genAi?: GenAiSpanData;
}

export interface CaptureInvocationInput {
	readonly run: CaptureRun;
	readonly method: CaptureMethod;
	readonly inputs?: Record<string, unknown>;
	readonly outputs?: Record<string, unknown>;
	/** Named payload values (e.g. input / expectedLabel / baselineLabel). */
	readonly payloads?: Record<string, string>;
	/** Payload names to redact; requires runKeyRef on the runtime. */
	readonly sensitiveFields?: readonly string[];
	readonly childSpans?: readonly CaptureChildSpan[];
	readonly status?: SpanStatus;
	/** GenAI data for the root span (when the wrapped call itself is the model call). */
	readonly genAi?: GenAiSpanData;
	readonly context?: TrajectoryContext;
	readonly scores?: readonly Score[];
	readonly feedback?: readonly Feedback[];
}

export interface CaptureResult {
	readonly captured: boolean;
	readonly trajectory: Trajectory | null;
	readonly trajectoryId: string;
}

export type ContentCaptureMode = "none" | "inline" | "ref";

export interface CaptureRuntimeOptions {
	/** Predetermined 16-hex span ids for deterministic tests; falls back to seq-derived ids. */
	readonly spanIds?: readonly string[];
	/** Predetermined ISO timestamps; falls back to a deterministic monotonic clock. */
	readonly clock?: readonly string[];
	/** Reference to the per-run key used to redact sensitive payloads. */
	readonly runKeyRef?: string;
	/** Redaction hook; defaults to a keyed sha256 digest placeholder — supply real encryption in production. */
	readonly encrypt?: (value: string, path: string, runKeyRef: string) => string;
	readonly sampling?: { readonly capture?: boolean; readonly reason?: string };
	readonly source?: string;
	/**
	 * How message/instruction content is recorded (OTel content-capture
	 * modes): "inline" stores it on the trajectory (default), "ref" replaces
	 * it with run-scoped refs via the encrypt hook, "none" drops it.
	 */
	readonly contentCapture?: ContentCaptureMode;
	/** Default trajectory context merged under each invocation's context. */
	readonly context?: TrajectoryContext;
}

export interface CaptureRuntime {
	captureInvocation(input: CaptureInvocationInput): CaptureResult;
	/** Records a late score for an already-captured trajectory (training.RewardObserved). */
	recordScore(input: { runId: string; trajectoryId: string; score: Score }): void;
	/** Records which trajectories evidence a proposed candidate (training.CandidateProposed). */
	recordCandidateProposed(input: { runId: string; candidate: CandidatePatch; trajectoryIds: readonly string[] }): void;
	eventLog(): TrainingEvent[];
}

export function createCaptureRuntime(options: CaptureRuntimeOptions = {}): CaptureRuntime {
	const eventLog: TrainingEvent[] = [];
	const spanIds = [...(options.spanIds ?? [])];
	const clock = [...(options.clock ?? [])];
	const sampling = {
		capture: options.sampling?.capture !== false,
		reason: options.sampling?.reason ?? "always-capture",
	};
	const contentCapture = options.contentCapture ?? "inline";
	const runKeyRef = options.runKeyRef;
	const encrypt =
		options.encrypt ??
		((value: string, path: string, keyRef: string) =>
			`enc:sha256:${createHash("sha256").update(`${keyRef}:${path}:${value}`).digest("hex")}`);
	let seq = 0;
	let generatedSpanCount = 0;
	let lastTimestampMs = -1;
	let invocationNumber = 0;

	function captureInvocation({
		run,
		method,
		inputs = {},
		outputs = {},
		payloads = {},
		sensitiveFields = [],
		childSpans = [],
		status,
		genAi,
		context,
		scores,
		feedback,
	}: CaptureInvocationInput): CaptureResult {
		const parentTrace = parseTraceparent(run?.traceparent);
		requireString(run?.id, "run.id");
		requireString(method?.name, "method.name");
		requireString(method?.contractRef, "method.contractRef");
		const code = codeFor(method);

		const trajectoryId = `trajectory-${run.id}-${++invocationNumber}`;

		if (!sampling.capture) {
			appendEvent({
				type: "training.TrajectorySampledOut",
				runId: run.id,
				traceparent: run.traceparent,
				data: { trajectoryId, methodName: method.name, reason: sampling.reason },
			});
			return { captured: false, trajectory: null, trajectoryId };
		}

		const sanitizedPayloads = sanitizePayloads({ payloads, sensitiveFields, runId: run.id });
		const mergedContext = mergeContext(options.context, context);
		const rootSpanId = nextSpanId();
		const rootGenAi = applyContentCapture(genAi, run.id, rootSpanId);
		const rootSpan: TrajectorySpan = {
			id: rootSpanId,
			parentId: null,
			traceId: parentTrace.traceId,
			name: method.name,
			startTime: now(),
			endTime: now(),
			...(status === undefined ? {} : { status }),
			attributes: {
				"openinference.span.kind": "CHAIN",
				"autocode.run.id": run.id,
				"autocode.contract.ref": method.contractRef,
				...dualConventionAttributes(rootGenAi === undefined ? {} : { genAi: rootGenAi }, mergedContext),
			},
			inputs: structuredClone(inputs),
			outputs: structuredClone(outputs),
			...(rootGenAi === undefined ? {} : { genAi: rootGenAi }),
		};
		const spans: TrajectorySpan[] = [
			rootSpan,
			...childSpans.map((span): TrajectorySpan => {
				const spanId = nextSpanId();
				const spanGenAi = applyContentCapture(span.genAi, run.id, spanId);
				return {
					id: spanId,
					parentId: rootSpanId,
					traceId: parentTrace.traceId,
					name: requireString(span.name, "childSpan.name"),
					startTime: now(),
					endTime: now(),
					...(span.status === undefined ? {} : { status: span.status }),
					attributes: {
						...structuredClone(span.attributes ?? {}),
						"openinference.span.kind": span.kind ?? "LLM",
						...dualConventionAttributes(spanGenAi === undefined ? {} : { genAi: spanGenAi }),
					},
					inputs: structuredClone(span.inputs ?? {}),
					outputs: structuredClone(span.outputs ?? {}),
					...(spanGenAi === undefined ? {} : { genAi: spanGenAi }),
				};
			}),
		];

		const resolvedFeedback = feedbackFor(scores, feedback);
		const base: Trajectory = {
			schema: TRAJECTORY_SCHEMA,
			id: trajectoryId,
			traceparent: run.traceparent,
			run: {
				id: run.id,
				...(run.tenantId === undefined ? {} : { tenantId: run.tenantId }),
				...(run.agent === undefined ? {} : { agent: structuredClone(run.agent) }),
			},
			subject: {
				method: method.name,
				contractRef: method.contractRef,
				generatedRegion: structuredClone(method.generatedRegion),
			},
			code,
			...(mergedContext === undefined ? {} : { context: mergedContext }),
			spans,
			payloads: sanitizedPayloads,
			...(scores === undefined ? {} : { scores: structuredClone(scores) as Score[] }),
			...(resolvedFeedback === undefined ? {} : { feedback: resolvedFeedback }),
		};
		const usage = aggregateTrajectoryUsage(base);
		const trajectory: Trajectory = usage === undefined ? base : { ...base, usage };

		const validation = validateTrajectory(trajectory);
		if (!validation.ok) {
			throw new TypeError(`captured trajectory is invalid: ${validation.errors.join("; ")}`);
		}

		for (const span of spans) {
			appendEvent({
				type: "telemetry.OpenInferenceSpanRecorded",
				runId: run.id,
				traceparent: run.traceparent,
				data: { trajectoryId, span },
			});
		}
		appendEvent({
			type: "training.TrajectoryCaptured",
			runId: run.id,
			traceparent: run.traceparent,
			data: { trajectoryId, trajectoryHash: hashTrajectory(trajectory), trajectory },
		});

		return { captured: true, trajectory: structuredClone(trajectory), trajectoryId };
	}

	function recordScore({ runId, trajectoryId, score }: { runId: string; trajectoryId: string; score: Score }): void {
		requireString(runId, "runId");
		requireString(trajectoryId, "trajectoryId");
		appendEvent({
			type: "training.RewardObserved",
			runId,
			traceparent: syntheticTraceparent(runId),
			data: { trajectoryId, score: structuredClone(score) },
		});
	}

	function recordCandidateProposed({
		runId,
		candidate,
		trajectoryIds,
	}: {
		runId: string;
		candidate: CandidatePatch;
		trajectoryIds: readonly string[];
	}): void {
		requireString(runId, "runId");
		if (!Array.isArray(trajectoryIds) || trajectoryIds.length === 0) {
			throw new TypeError("trajectoryIds must be a non-empty array");
		}
		appendEvent({
			type: "training.CandidateProposed",
			runId,
			traceparent: syntheticTraceparent(runId),
			data: { candidate: structuredClone(candidate), trajectoryIds: [...trajectoryIds] },
		});
	}

	function applyContentCapture(
		genAi: GenAiSpanData | undefined,
		runId: string,
		spanId: string,
	): GenAiSpanData | undefined {
		if (genAi === undefined || contentCapture === "inline") {
			return genAi === undefined ? undefined : structuredClone(genAi);
		}
		const redactMessages = (messages: readonly GenAiMessage[] | undefined, direction: string) =>
			messages?.map((message, index): GenAiMessage => {
				if (message.content === undefined || typeof message.content !== "string") {
					return structuredClone(message);
				}
				if (contentCapture === "none") {
					const { content: _content, ...rest } = message;
					return structuredClone(rest);
				}
				const path = `spans/${spanId}/${direction}/${index}`;
				if (!runKeyRef) {
					throw new TypeError("contentCapture \"ref\" requires a runKeyRef on the capture runtime");
				}
				const ciphertext = encrypt(message.content, path, runKeyRef);
				return { ...structuredClone(message), content: { ref: `run://${runId}/${path}`, ciphertext } };
			});

		const result = {
			...structuredClone(genAi),
			...(genAi.inputMessages === undefined
				? {}
				: { inputMessages: redactMessages(genAi.inputMessages, "input") }),
			...(genAi.outputMessages === undefined
				? {}
				: { outputMessages: redactMessages(genAi.outputMessages, "output") }),
		};
		if (typeof genAi.systemInstructions === "string") {
			if (contentCapture === "none") {
				const { systemInstructions: _instructions, ...rest } = result;
				return rest as GenAiSpanData;
			}
			if (!runKeyRef) {
				throw new TypeError("contentCapture \"ref\" requires a runKeyRef on the capture runtime");
			}
			const path = `spans/${spanId}/system_instructions`;
			const ciphertext = encrypt(genAi.systemInstructions, path, runKeyRef);
			return { ...result, systemInstructions: { ref: `run://${runId}/${path}`, ciphertext } } as GenAiSpanData;
		}
		return result as GenAiSpanData;
	}

	function appendEvent({
		type,
		runId,
		traceparent,
		data,
	}: {
		type: TrainingEvent["type"];
		runId: string;
		traceparent: string;
		data: Record<string, unknown>;
	}): void {
		const event = createTrainingEvent({
			id: `evt-${seq}`,
			type,
			runId,
			seq,
			time: now(),
			traceparent,
			...(options.source === undefined ? {} : { source: options.source }),
			data,
		});
		seq += 1;
		eventLog.push(event);
	}

	function sanitizePayloads({
		payloads,
		sensitiveFields,
		runId,
	}: {
		payloads: Record<string, string>;
		sensitiveFields: readonly string[];
		runId: string;
	}): Record<string, TrajectoryPayload> {
		const sensitive = new Set(sensitiveFields);
		return Object.fromEntries(
			Object.entries(payloads).map(([name, value]) => {
				if (!sensitive.has(name)) {
					return [name, { classification: "public", redaction: "none", value }];
				}
				if (!runKeyRef) {
					throw new TypeError(`sensitive payload ${name} requires a runKeyRef on the capture runtime`);
				}
				return [
					name,
					{
						classification: "pii",
						redaction: "encrypted",
						encryptedRef: `run://${runId}/payloads/${name}`,
						runKeyRef,
						ciphertext: encrypt(value, name, runKeyRef),
					} as TrajectoryPayload,
				];
			}),
		);
	}

	function nextSpanId(): string {
		const value =
			spanIds.shift() ??
			createHash("sha256").update(`span-${seq}-${generatedSpanCount++}`).digest("hex").slice(0, 16);
		if (!/^[0-9a-f]{16}$/.test(value) || value === "0000000000000000") {
			throw new TypeError("spanId must be 16 lowercase hex characters and not all zeroes");
		}
		return value;
	}

	function now(): string {
		const value = clock.shift();
		const timestamp = value === undefined ? lastTimestampMs + 1 : Date.parse(value);
		if (Number.isNaN(timestamp)) {
			throw new TypeError("clock values must be ISO-8601 timestamps");
		}
		lastTimestampMs = Math.max(lastTimestampMs, timestamp);
		return new Date(timestamp).toISOString();
	}

	return {
		captureInvocation,
		recordScore,
		recordCandidateProposed,
		eventLog: () => structuredClone(eventLog),
	};
}

export interface TrainableOptions<Args extends readonly unknown[], Result> {
	readonly runtime: CaptureRuntime;
	readonly run: CaptureRun;
	readonly method: CaptureMethod;
	readonly context?: TrajectoryContext;
	/** Maps call arguments to root-span inputs; default { input: args[0] }. */
	readonly mapInputs?: (...args: Args) => Record<string, unknown>;
	/** Maps the return value to root-span outputs; default { output: result }. */
	readonly mapOutputs?: (result: Result) => Record<string, unknown>;
	/** Maps a call to named payload values; default records string input/baselineLabel. */
	readonly mapPayloads?: (args: Args, result: Result | undefined) => Record<string, string>;
	/** Maps a call to GenAI data for the root span (model/usage/messages). */
	readonly mapGenAi?: (args: Args, result: Result | undefined) => GenAiSpanData | undefined;
	readonly sensitiveFields?: readonly string[];
}

export interface TrainableFunction<Args extends readonly unknown[], Result> {
	(...args: Args): Result;
	/** The region this function's body is bound to — its trainable parameter. */
	readonly region: GeneratedRegion;
	/** Trajectory ids captured by this wrapper, in call order. */
	readonly trajectoryIds: readonly string[];
}

/**
 * The Trace `@bundle(trainable=True)` analogue: wraps a function so every
 * call records a trajectory against its generated region and code version.
 * A throw is captured as error feedback with an ERROR span status (errors
 * are optimizer signal, per Trace) and rethrown.
 */
export function trainable<Args extends readonly unknown[], Result>(
	fn: (...args: Args) => Result,
	{
		runtime,
		run,
		method,
		context,
		mapInputs = (...args: Args) => ({ input: args[0] }),
		mapOutputs = (result: Result) => ({ output: result }),
		mapPayloads = defaultPayloads,
		mapGenAi,
		sensitiveFields = [],
	}: TrainableOptions<Args, Result>,
): TrainableFunction<Args, Result> {
	const trajectoryIds: string[] = [];

	const wrapped = (...args: Args): Result => {
		let result: Result;
		try {
			result = fn(...args);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const genAi = mapGenAi?.(args, undefined);
			const capture = runtime.captureInvocation({
				run,
				method,
				...(context === undefined ? {} : { context }),
				inputs: mapInputs(...args),
				outputs: {},
				payloads: mapPayloads(args, undefined),
				sensitiveFields,
				status: { code: "ERROR", message },
				...(genAi === undefined ? {} : { genAi }),
				feedback: [{ kind: "error", message }],
			});
			trajectoryIds.push(capture.trajectoryId);
			throw error;
		}

		const genAi = mapGenAi?.(args, result);
		const capture = runtime.captureInvocation({
			run,
			method,
			...(context === undefined ? {} : { context }),
			inputs: mapInputs(...args),
			outputs: mapOutputs(result),
			payloads: mapPayloads(args, result),
			sensitiveFields,
			status: { code: "OK" },
			...(genAi === undefined ? {} : { genAi }),
			feedback: [{ kind: "text", text: `reward pending: ${method.contractRef}` }],
		});
		trajectoryIds.push(capture.trajectoryId);
		return result;
	};

	return Object.assign(wrapped, {
		region: method.generatedRegion,
		trajectoryIds: trajectoryIds as readonly string[],
	});
}

function codeFor(method: CaptureMethod): TrajectoryCode {
	const regionDigest = method.regionDigest ?? (method.regionSource === undefined ? undefined : digest(method.regionSource));
	if (!isNonEmptyString(regionDigest)) {
		throw new TypeError("method.regionDigest or method.regionSource is required (training attribution)");
	}
	return {
		regionDigest,
		...(method.candidateId === undefined ? {} : { candidateId: method.candidateId }),
		...(method.arm === undefined ? {} : { arm: method.arm }),
	};
}

function mergeContext(
	base: TrajectoryContext | undefined,
	override: TrajectoryContext | undefined,
): TrajectoryContext | undefined {
	if (base === undefined) {
		return override === undefined ? undefined : structuredClone(override);
	}
	if (override === undefined) {
		return structuredClone(base);
	}
	return { ...structuredClone(base), ...structuredClone(override) };
}

function defaultPayloads(args: readonly unknown[], result: unknown): Record<string, string> {
	const payloads: Record<string, string> = {};
	if (typeof args[0] === "string") {
		payloads["input"] = args[0];
	}
	if (typeof result === "string") {
		payloads["baselineLabel"] = result;
	}
	return payloads;
}

/**
 * Rebuilds a captured trajectory from the event log alone, enforcing the
 * audit invariants: the hash must match and every span must have been
 * individually recorded.
 */
export function reconstructTrajectoryFromLog(events: readonly TrainingEvent[], trajectoryId: string): Trajectory {
	requireString(trajectoryId, "trajectoryId");
	const ordered = orderEvents(events);
	const captured = ordered.find(
		(event) => event.type === "training.TrajectoryCaptured" && event.data["trajectoryId"] === trajectoryId,
	);

	if (!captured) {
		const spanEvidence = ordered.some(
			(event) => event.type === "telemetry.OpenInferenceSpanRecorded" && event.data["trajectoryId"] === trajectoryId,
		);
		if (spanEvidence) {
			throw new Error("audit invariant: OpenInference spans exist but trajectory was not appended");
		}
		const sampledOut = ordered.find(
			(event) => event.type === "training.TrajectorySampledOut" && event.data["trajectoryId"] === trajectoryId,
		);
		if (sampledOut) {
			throw new Error(`trajectory ${trajectoryId} was sampled out: ${String(sampledOut.data["reason"])}`);
		}
		throw new Error(`trajectory ${trajectoryId} not found`);
	}

	const trajectory = structuredClone(captured.data["trajectory"]) as Trajectory;
	if (captured.data["trajectoryHash"] !== hashTrajectory(trajectory)) {
		throw new Error(`trajectory ${trajectoryId} hash mismatch`);
	}

	const spanEvents = ordered.filter(
		(event) => event.type === "telemetry.OpenInferenceSpanRecorded" && event.data["trajectoryId"] === trajectoryId,
	);
	for (const span of trajectory.spans ?? []) {
		if (!spanEvents.some((event) => isRecord(event.data["span"]) && event.data["span"]["id"] === span.id)) {
			throw new Error(`audit invariant: trajectory span ${span.id} missing from log`);
		}
	}

	return trajectory;
}

/** Recovers the hash-verified evidence set behind a proposed candidate. */
export function recoverCandidateTrajectorySet(
	events: readonly TrainingEvent[],
	candidateId: string,
): { trajectory: Trajectory; hash: string }[] {
	requireString(candidateId, "candidateId");
	const ordered = orderEvents(events);
	const proposed = ordered.find(
		(event) =>
			event.type === "training.CandidateProposed" &&
			isRecord(event.data["candidate"]) &&
			event.data["candidate"]["id"] === candidateId,
	);
	if (!proposed) {
		throw new Error(`candidate ${candidateId} provenance not found`);
	}
	const trajectoryIds = proposed.data["trajectoryIds"];
	if (!Array.isArray(trajectoryIds) || trajectoryIds.length === 0) {
		throw new Error(`candidate ${candidateId} has no recorded trajectory ids`);
	}

	return trajectoryIds.map((trajectoryId) => {
		const trajectory = reconstructTrajectoryFromLog(ordered, String(trajectoryId));
		return { trajectory, hash: hashTrajectory(trajectory) };
	});
}

function feedbackFor(
	scores: readonly Score[] | undefined,
	feedback: readonly Feedback[] | undefined,
): readonly Feedback[] | undefined {
	if (feedback !== undefined) {
		return structuredClone(feedback) as Feedback[];
	}
	if (scores === undefined || scores.length === 0) {
		return [{ kind: "text", text: "reward pending" }];
	}
	return undefined;
}

function parseTraceparent(value: string | undefined): { traceId: string; spanId: string; flags: string } {
	const match = TRACEPARENT_CAPTURE_PATTERN.exec(value ?? "");
	if (!match) {
		throw new TypeError("run.traceparent must be a valid W3C traceparent");
	}
	return { traceId: match[1] as string, spanId: match[2] as string, flags: match[3] as string };
}

function syntheticTraceparent(runId: string): string {
	const hash = createHash("sha256").update(runId).digest("hex");
	return `00-${hash.slice(0, 32)}-${hash.slice(32, 48)}-01`;
}

function requireString(value: unknown, name: string): string {
	if (!isNonEmptyString(value)) {
		throw new TypeError(`${name} must be a non-empty string`);
	}
	return value;
}

function orderEvents(events: readonly TrainingEvent[]): TrainingEvent[] {
	if (!Array.isArray(events)) {
		throw new TypeError("events must be an array");
	}
	return [...events].sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
}
