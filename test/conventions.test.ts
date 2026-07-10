import { describe, expect, it } from "vitest";

import {
	contextFromConventionAttributes,
	dualConventionAttributes,
	fromConventionAttributes,
	type GenAiSpanData,
} from "../src/index.js";

const genAi: GenAiSpanData = {
	provider: "anthropic",
	operation: "chat",
	requestModel: "claude-sonnet-5",
	responseModel: "claude-sonnet-5",
	responseId: "resp-1",
	finishReasons: ["stop"],
	invocationParameters: { temperature: 0.2, max_tokens: 512 },
	usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160, cacheReadInputTokens: 100 },
	cost: { inputUsd: 0.0004, outputUsd: 0.0006, totalUsd: 0.001 },
	inputMessages: [
		{ role: "system", content: "You are a classifier." },
		{ role: "user", content: "billing invoice refund" },
	],
	outputMessages: [{ role: "assistant", content: "billing-support" }],
};

describe("dualConventionAttributes", () => {
	it("emits both gen_ai.* and OpenInference keys for the same data", () => {
		const attributes = dualConventionAttributes({ genAi });

		// OTel GenAI vocabulary.
		expect(attributes["gen_ai.provider.name"]).toBe("anthropic");
		expect(attributes["gen_ai.operation.name"]).toBe("chat");
		expect(attributes["gen_ai.request.model"]).toBe("claude-sonnet-5");
		expect(attributes["gen_ai.request.temperature"]).toBe(0.2);
		expect(attributes["gen_ai.response.finish_reasons"]).toEqual(["stop"]);
		expect(attributes["gen_ai.usage.input_tokens"]).toBe(120);
		expect(attributes["gen_ai.usage.output_tokens"]).toBe(40);
		expect(attributes["gen_ai.usage.cache_read.input_tokens"]).toBe(100);

		// OpenInference vocabulary, same values.
		expect(attributes["llm.provider"]).toBe("anthropic");
		expect(attributes["llm.model_name"]).toBe("claude-sonnet-5");
		expect(attributes["llm.token_count.prompt"]).toBe(120);
		expect(attributes["llm.token_count.completion"]).toBe(40);
		expect(attributes["llm.token_count.total"]).toBe(160);
		expect(attributes["llm.cost.total"]).toBe(0.001);
		expect(attributes["llm.input_messages.0.message.role"]).toBe("system");
		expect(attributes["llm.input_messages.1.message.content"]).toBe("billing invoice refund");
		expect(attributes["llm.output_messages.0.message.content"]).toBe("billing-support");
		expect(JSON.parse(attributes["llm.invocation_parameters"] as string)).toEqual({
			temperature: 0.2,
			max_tokens: 512,
		});
	});

	it("emits session/user/tags/metadata from trajectory context", () => {
		const attributes = dualConventionAttributes(
			{},
			{
				session: { id: "session-9" },
				user: { id: "user-3" },
				tags: ["checkout"],
				metadata: { featureFlag: "on" },
			},
		);

		expect(attributes["session.id"]).toBe("session-9");
		expect(attributes["gen_ai.conversation.id"]).toBe("session-9");
		expect(attributes["user.id"]).toBe("user-3");
		expect(attributes["tag.tags"]).toEqual(["checkout"]);
		expect(JSON.parse(attributes["metadata"] as string)).toEqual({ featureFlag: "on" });
	});
});

describe("fromConventionAttributes", () => {
	it("round-trips a genAi block through attributes", () => {
		const recovered = fromConventionAttributes(dualConventionAttributes({ genAi }));

		expect(recovered?.provider).toBe("anthropic");
		expect(recovered?.requestModel).toBe("claude-sonnet-5");
		expect(recovered?.usage).toEqual({
			inputTokens: 120,
			outputTokens: 40,
			totalTokens: 160,
			cacheReadInputTokens: 100,
		});
		expect(recovered?.cost).toEqual({ inputUsd: 0.0004, outputUsd: 0.0006, totalUsd: 0.001 });
		expect(recovered?.inputMessages).toEqual(genAi.inputMessages);
		expect(recovered?.outputMessages).toEqual(genAi.outputMessages);
		expect(recovered?.invocationParameters).toEqual({ temperature: 0.2, max_tokens: 512 });
	});

	it("reads OpenInference-only instrumentation (foreign spans)", () => {
		const recovered = fromConventionAttributes({
			"llm.model_name": "gpt-oss",
			"llm.provider": "openai",
			"llm.token_count.prompt": 10,
			"llm.token_count.completion": 3,
			"llm.input_messages.0.message.role": "user",
			"llm.input_messages.0.message.content": "hello",
		});

		expect(recovered?.requestModel).toBe("gpt-oss");
		expect(recovered?.usage?.inputTokens).toBe(10);
		expect(recovered?.inputMessages).toEqual([{ role: "user", content: "hello" }]);
	});

	it("reads gen_ai.*-only instrumentation and returns undefined for non-GenAI spans", () => {
		const recovered = fromConventionAttributes({
			"gen_ai.request.model": "nova",
			"gen_ai.usage.input_tokens": 7,
			"gen_ai.usage.output_tokens": 2,
			"gen_ai.request.temperature": 0.5,
		});
		expect(recovered?.requestModel).toBe("nova");
		expect(recovered?.usage).toEqual({ inputTokens: 7, outputTokens: 2 });
		expect(recovered?.invocationParameters).toEqual({ temperature: 0.5 });

		expect(fromConventionAttributes({ "http.method": "GET" })).toBeUndefined();
	});
});

describe("contextFromConventionAttributes", () => {
	it("recovers session/user/tags/metadata", () => {
		const context = contextFromConventionAttributes({
			"session.id": "session-9",
			"user.id": "user-3",
			"tag.tags": ["checkout"],
			metadata: JSON.stringify({ featureFlag: "on" }),
		});

		expect(context).toEqual({
			session: { id: "session-9" },
			user: { id: "user-3" },
			tags: ["checkout"],
			metadata: { featureFlag: "on" },
		});
	});
});
