import { isRecord } from "./canonical.js";
import type {
	Cost,
	GenAiMessage,
	GenAiSpanData,
	MessageContent,
	TrajectoryContext,
	TrajectorySpan,
	Usage,
} from "./trajectory.js";

// Dual-convention attribute vocabulary. The industry has two live standards
// for GenAI telemetry — OTel gen_ai.* (semantic-conventions-genai, status:
// Development) and OpenInference (Arize; the LLM-observability de-facto).
// Superset policy: emit BOTH on export and read EITHER on ingest, so a shift
// in which convention wins never forces recapture.

/** OTel GenAI semantic convention attribute names (gen_ai.*). */
export const GEN_AI_ATTR = Object.freeze({
	providerName: "gen_ai.provider.name",
	operationName: "gen_ai.operation.name",
	requestModel: "gen_ai.request.model",
	responseModel: "gen_ai.response.model",
	responseId: "gen_ai.response.id",
	responseFinishReasons: "gen_ai.response.finish_reasons",
	usageInputTokens: "gen_ai.usage.input_tokens",
	usageOutputTokens: "gen_ai.usage.output_tokens",
	usageCacheReadInputTokens: "gen_ai.usage.cache_read.input_tokens",
	usageReasoningOutputTokens: "gen_ai.usage.reasoning.output_tokens",
	conversationId: "gen_ai.conversation.id",
	inputMessages: "gen_ai.input.messages",
	outputMessages: "gen_ai.output.messages",
	systemInstructions: "gen_ai.system_instructions",
	toolName: "gen_ai.tool.name",
	errorType: "error.type",
	requestParamPrefix: "gen_ai.request.",
} as const);

/** OpenInference attribute names (llm.*, session/user/tags/metadata). */
export const OPENINFERENCE_ATTR = Object.freeze({
	spanKind: "openinference.span.kind",
	provider: "llm.provider",
	system: "llm.system",
	modelName: "llm.model_name",
	invocationParameters: "llm.invocation_parameters",
	finishReason: "llm.finish_reason",
	tokenCountPrompt: "llm.token_count.prompt",
	tokenCountCompletion: "llm.token_count.completion",
	tokenCountTotal: "llm.token_count.total",
	tokenCountCacheRead: "llm.token_count.prompt_details.cache_read",
	tokenCountReasoning: "llm.token_count.completion_details.reasoning",
	costPrompt: "llm.cost.prompt",
	costCompletion: "llm.cost.completion",
	costTotal: "llm.cost.total",
	inputMessagesPrefix: "llm.input_messages.",
	outputMessagesPrefix: "llm.output_messages.",
	inputValue: "input.value",
	outputValue: "output.value",
	sessionId: "session.id",
	userId: "user.id",
	tags: "tag.tags",
	metadata: "metadata",
} as const);

/** ts-autocode binding attributes for round-tripping through OTLP. */
export const AUTOCODE_ATTR = Object.freeze({
	trajectoryId: "autocode.trajectory.id",
	traceparent: "autocode.traceparent",
	runId: "autocode.run.id",
	tenantId: "autocode.tenant.id",
	agentId: "autocode.agent.id",
	agentPrincipalRef: "autocode.agent.principal_ref",
	method: "autocode.method",
	contractRef: "autocode.contract.ref",
	regionId: "autocode.region.id",
	regionArtifactRef: "autocode.region.artifact_ref",
	regionStartOffset: "autocode.region.start_offset",
	regionEndOffset: "autocode.region.end_offset",
	regionOwner: "autocode.region.owner",
	regionDigest: "autocode.region.digest",
	candidateId: "autocode.candidate.id",
	arm: "autocode.arm",
	environment: "autocode.environment",
	release: "autocode.release",
	payloadPrefix: "autocode.payload.",
	payloadRefPrefix: "autocode.payload_ref.",
	payloadClassPrefix: "autocode.payload_class.",
	scoreEventName: "autocode.score",
	feedbackEventName: "autocode.feedback",
} as const);

/**
 * Derives a merged attribute map from a span's typed genAi block (plus
 * optional trajectory context), emitting BOTH gen_ai.* and OpenInference
 * keys. Message content is serialized as JSON; { ref } content stays a ref.
 */
export function dualConventionAttributes(
	span: Pick<TrajectorySpan, "genAi">,
	context?: TrajectoryContext,
): Record<string, unknown> {
	const attributes: Record<string, unknown> = {};
	const genAi = span.genAi;

	if (genAi) {
		setBoth(attributes, GEN_AI_ATTR.providerName, OPENINFERENCE_ATTR.provider, genAi.provider);
		if (genAi.operation !== undefined) {
			attributes[GEN_AI_ATTR.operationName] = genAi.operation;
		}
		setBoth(attributes, GEN_AI_ATTR.requestModel, OPENINFERENCE_ATTR.modelName, genAi.requestModel);
		if (genAi.responseModel !== undefined) {
			attributes[GEN_AI_ATTR.responseModel] = genAi.responseModel;
		}
		if (genAi.responseId !== undefined) {
			attributes[GEN_AI_ATTR.responseId] = genAi.responseId;
		}
		if (genAi.finishReasons !== undefined) {
			attributes[GEN_AI_ATTR.responseFinishReasons] = [...genAi.finishReasons];
			attributes[OPENINFERENCE_ATTR.finishReason] = genAi.finishReasons[0];
		}
		if (genAi.invocationParameters !== undefined) {
			attributes[OPENINFERENCE_ATTR.invocationParameters] = JSON.stringify(genAi.invocationParameters);
			for (const [key, value] of Object.entries(genAi.invocationParameters)) {
				if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
					attributes[`${GEN_AI_ATTR.requestParamPrefix}${key}`] = value;
				}
			}
		}
		const usage = genAi.usage;
		if (usage) {
			setBoth(attributes, GEN_AI_ATTR.usageInputTokens, OPENINFERENCE_ATTR.tokenCountPrompt, usage.inputTokens);
			setBoth(
				attributes,
				GEN_AI_ATTR.usageOutputTokens,
				OPENINFERENCE_ATTR.tokenCountCompletion,
				usage.outputTokens,
			);
			if (usage.totalTokens !== undefined) {
				attributes[OPENINFERENCE_ATTR.tokenCountTotal] = usage.totalTokens;
			}
			setBoth(
				attributes,
				GEN_AI_ATTR.usageCacheReadInputTokens,
				OPENINFERENCE_ATTR.tokenCountCacheRead,
				usage.cacheReadInputTokens,
			);
			setBoth(
				attributes,
				GEN_AI_ATTR.usageReasoningOutputTokens,
				OPENINFERENCE_ATTR.tokenCountReasoning,
				usage.reasoningOutputTokens,
			);
		}
		const cost = genAi.cost;
		if (cost) {
			if (cost.inputUsd !== undefined) {
				attributes[OPENINFERENCE_ATTR.costPrompt] = cost.inputUsd;
			}
			if (cost.outputUsd !== undefined) {
				attributes[OPENINFERENCE_ATTR.costCompletion] = cost.outputUsd;
			}
			if (cost.totalUsd !== undefined) {
				attributes[OPENINFERENCE_ATTR.costTotal] = cost.totalUsd;
			}
		}
		if (genAi.inputMessages !== undefined) {
			attributes[GEN_AI_ATTR.inputMessages] = JSON.stringify(genAi.inputMessages);
			flattenMessages(attributes, OPENINFERENCE_ATTR.inputMessagesPrefix, genAi.inputMessages);
		}
		if (genAi.outputMessages !== undefined) {
			attributes[GEN_AI_ATTR.outputMessages] = JSON.stringify(genAi.outputMessages);
			flattenMessages(attributes, OPENINFERENCE_ATTR.outputMessagesPrefix, genAi.outputMessages);
		}
		if (genAi.systemInstructions !== undefined) {
			attributes[GEN_AI_ATTR.systemInstructions] = contentToString(genAi.systemInstructions);
		}
	}

	if (context) {
		if (context.session?.id !== undefined) {
			attributes[OPENINFERENCE_ATTR.sessionId] = context.session.id;
			attributes[GEN_AI_ATTR.conversationId] = context.session.id;
		}
		if (context.user?.id !== undefined) {
			attributes[OPENINFERENCE_ATTR.userId] = context.user.id;
		}
		if (context.tags !== undefined) {
			attributes[OPENINFERENCE_ATTR.tags] = [...context.tags];
		}
		if (context.metadata !== undefined) {
			attributes[OPENINFERENCE_ATTR.metadata] = JSON.stringify(context.metadata);
		}
	}

	return attributes;
}

/**
 * The inverse: reads a span attribute map in EITHER vocabulary (gen_ai.*
 * preferred, OpenInference fallback — including flattened
 * llm.input_messages.<i>.message.*) back into a typed genAi block.
 * Returns undefined when no GenAI signal is present.
 */
export function fromConventionAttributes(attributes: Record<string, unknown>): GenAiSpanData | undefined {
	const genAi: {
		provider?: string;
		operation?: string;
		requestModel?: string;
		responseModel?: string;
		responseId?: string;
		finishReasons?: string[];
		invocationParameters?: Record<string, unknown>;
		usage?: Usage;
		cost?: Cost;
		inputMessages?: GenAiMessage[];
		outputMessages?: GenAiMessage[];
		systemInstructions?: MessageContent;
	} = {};

	const provider = firstString(attributes, [GEN_AI_ATTR.providerName, OPENINFERENCE_ATTR.provider]);
	if (provider !== undefined) genAi.provider = provider;
	const operation = firstString(attributes, [GEN_AI_ATTR.operationName]);
	if (operation !== undefined) genAi.operation = operation;
	const requestModel = firstString(attributes, [GEN_AI_ATTR.requestModel, OPENINFERENCE_ATTR.modelName]);
	if (requestModel !== undefined) genAi.requestModel = requestModel;
	const responseModel = firstString(attributes, [GEN_AI_ATTR.responseModel]);
	if (responseModel !== undefined) genAi.responseModel = responseModel;
	const responseId = firstString(attributes, [GEN_AI_ATTR.responseId]);
	if (responseId !== undefined) genAi.responseId = responseId;

	const finishReasons = attributes[GEN_AI_ATTR.responseFinishReasons];
	if (Array.isArray(finishReasons)) {
		genAi.finishReasons = finishReasons.map(String);
	} else {
		const single = firstString(attributes, [OPENINFERENCE_ATTR.finishReason]);
		if (single !== undefined) genAi.finishReasons = [single];
	}

	const invocationJson = firstString(attributes, [OPENINFERENCE_ATTR.invocationParameters]);
	if (invocationJson !== undefined) {
		const parsed = tryParseJson(invocationJson);
		if (isRecord(parsed)) genAi.invocationParameters = parsed;
	} else {
		const params: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(attributes)) {
			if (key.startsWith(GEN_AI_ATTR.requestParamPrefix) && key !== GEN_AI_ATTR.requestModel) {
				params[key.slice(GEN_AI_ATTR.requestParamPrefix.length)] = value;
			}
		}
		if (Object.keys(params).length > 0) genAi.invocationParameters = params;
	}

	const inputTokens = firstInteger(attributes, [GEN_AI_ATTR.usageInputTokens, OPENINFERENCE_ATTR.tokenCountPrompt]);
	const outputTokens = firstInteger(attributes, [
		GEN_AI_ATTR.usageOutputTokens,
		OPENINFERENCE_ATTR.tokenCountCompletion,
	]);
	if (inputTokens !== undefined && outputTokens !== undefined) {
		const totalTokens = firstInteger(attributes, [OPENINFERENCE_ATTR.tokenCountTotal]);
		const cacheRead = firstInteger(attributes, [
			GEN_AI_ATTR.usageCacheReadInputTokens,
			OPENINFERENCE_ATTR.tokenCountCacheRead,
		]);
		const reasoning = firstInteger(attributes, [
			GEN_AI_ATTR.usageReasoningOutputTokens,
			OPENINFERENCE_ATTR.tokenCountReasoning,
		]);
		genAi.usage = {
			inputTokens,
			outputTokens,
			...(totalTokens === undefined ? {} : { totalTokens }),
			...(cacheRead === undefined ? {} : { cacheReadInputTokens: cacheRead }),
			...(reasoning === undefined ? {} : { reasoningOutputTokens: reasoning }),
		};
	}

	const inputUsd = firstNumber(attributes, [OPENINFERENCE_ATTR.costPrompt]);
	const outputUsd = firstNumber(attributes, [OPENINFERENCE_ATTR.costCompletion]);
	const totalUsd = firstNumber(attributes, [OPENINFERENCE_ATTR.costTotal]);
	if (inputUsd !== undefined || outputUsd !== undefined || totalUsd !== undefined) {
		genAi.cost = {
			...(inputUsd === undefined ? {} : { inputUsd }),
			...(outputUsd === undefined ? {} : { outputUsd }),
			...(totalUsd === undefined ? {} : { totalUsd }),
		};
	}

	const inputMessages =
		parseMessagesJson(attributes[GEN_AI_ATTR.inputMessages]) ??
		unflattenMessages(attributes, OPENINFERENCE_ATTR.inputMessagesPrefix);
	if (inputMessages !== undefined) genAi.inputMessages = inputMessages;
	const outputMessages =
		parseMessagesJson(attributes[GEN_AI_ATTR.outputMessages]) ??
		unflattenMessages(attributes, OPENINFERENCE_ATTR.outputMessagesPrefix);
	if (outputMessages !== undefined) genAi.outputMessages = outputMessages;

	const systemInstructions = firstString(attributes, [GEN_AI_ATTR.systemInstructions]);
	if (systemInstructions !== undefined) genAi.systemInstructions = systemInstructions;

	return Object.keys(genAi).length > 0 ? genAi : undefined;
}

/** Reads session/user/tags/metadata context back from attributes. */
export function contextFromConventionAttributes(
	attributes: Record<string, unknown>,
): TrajectoryContext | undefined {
	const context: {
		session?: { id: string };
		user?: { id: string };
		tags?: string[];
		metadata?: Record<string, unknown>;
		environment?: string;
		release?: string;
	} = {};
	const sessionId = firstString(attributes, [OPENINFERENCE_ATTR.sessionId, GEN_AI_ATTR.conversationId]);
	if (sessionId !== undefined) context.session = { id: sessionId };
	const userId = firstString(attributes, [OPENINFERENCE_ATTR.userId]);
	if (userId !== undefined) context.user = { id: userId };
	const tags = attributes[OPENINFERENCE_ATTR.tags];
	if (Array.isArray(tags)) context.tags = tags.map(String);
	const metadataJson = firstString(attributes, [OPENINFERENCE_ATTR.metadata]);
	if (metadataJson !== undefined) {
		const parsed = tryParseJson(metadataJson);
		if (isRecord(parsed)) context.metadata = parsed;
	}
	const environment = firstString(attributes, [AUTOCODE_ATTR.environment]);
	if (environment !== undefined) context.environment = environment;
	const release = firstString(attributes, [AUTOCODE_ATTR.release]);
	if (release !== undefined) context.release = release;
	return Object.keys(context).length > 0 ? context : undefined;
}

function flattenMessages(
	attributes: Record<string, unknown>,
	prefix: string,
	messages: readonly GenAiMessage[],
): void {
	messages.forEach((message, index) => {
		attributes[`${prefix}${index}.message.role`] = message.role;
		if (message.content !== undefined) {
			attributes[`${prefix}${index}.message.content`] = contentToString(message.content);
		}
	});
}

function unflattenMessages(attributes: Record<string, unknown>, prefix: string): GenAiMessage[] | undefined {
	const byIndex = new Map<number, { role?: string; content?: string }>();
	for (const [key, value] of Object.entries(attributes)) {
		if (!key.startsWith(prefix)) {
			continue;
		}
		const match = /^(\d+)\.message\.(role|content)$/.exec(key.slice(prefix.length));
		if (!match) {
			continue;
		}
		const index = Number(match[1]);
		const entry = byIndex.get(index) ?? {};
		entry[match[2] as "role" | "content"] = String(value);
		byIndex.set(index, entry);
	}
	if (byIndex.size === 0) {
		return undefined;
	}
	return [...byIndex.entries()]
		.sort((left, right) => left[0] - right[0])
		.map(([, entry]) => ({
			role: (entry.role ?? "user") as GenAiMessage["role"],
			...(entry.content === undefined ? {} : { content: parseContent(entry.content) }),
		}));
}

function parseMessagesJson(value: unknown): GenAiMessage[] | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const parsed = tryParseJson(value);
	return Array.isArray(parsed) ? (parsed as GenAiMessage[]) : undefined;
}

function contentToString(content: MessageContent): string {
	return typeof content === "string" ? content : `ref:${content.ref}`;
}

function parseContent(value: string): MessageContent {
	return value.startsWith("ref:") ? { ref: value.slice(4) } : value;
}

function setBoth(
	attributes: Record<string, unknown>,
	genAiKey: string,
	openInferenceKey: string,
	value: unknown,
): void {
	if (value === undefined) {
		return;
	}
	attributes[genAiKey] = value;
	attributes[openInferenceKey] = value;
}

function firstString(attributes: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = attributes[key];
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}
	return undefined;
}

function firstInteger(attributes: Record<string, unknown>, keys: readonly string[]): number | undefined {
	for (const key of keys) {
		const value = attributes[key];
		if (typeof value === "number" && Number.isInteger(value)) {
			return value;
		}
	}
	return undefined;
}

function firstNumber(attributes: Record<string, unknown>, keys: readonly string[]): number | undefined {
	for (const key of keys) {
		const value = attributes[key];
		if (typeof value === "number" && Number.isFinite(value)) {
			return value;
		}
	}
	return undefined;
}

function tryParseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}
