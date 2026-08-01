/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import type { CancellationToken } from "../../types";
import { OpenAIClient } from "../OpenAIClient";

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

const breakpointProviderOptions = {
	openai: { promptCacheBreakpoint: { mode: "explicit" } },
};

function breakpointPaths(value: unknown, path = ""): string[] {
	if (Array.isArray(value)) {
		return value.flatMap((item, index) => breakpointPaths(item, `${path}[${index}]`));
	}
	if (value === null || typeof value !== "object") {
		return [];
	}

	const paths: string[] = [];
	for (const [key, child] of Object.entries(value)) {
		const childPath = path ? `${path}.${key}` : key;
		if (key === "prompt_cache_breakpoint") {
			paths.push(childPath);
		} else {
			paths.push(...breakpointPaths(child, childPath));
		}
	}
	return paths;
}

function markedContinuationMessages(): ModelMessage[] {
	return [
		{
			role: "system",
			content: "System instruction",
			providerOptions: breakpointProviderOptions,
		},
		{
			role: "user",
			content: [
				{
					type: "text",
					text: "Stable user input",
					providerOptions: breakpointProviderOptions,
				},
			],
		},
		{ role: "user", content: "Dynamic environment reminder" },
		{
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "call-1",
					toolName: "lookup",
					input: { query: "cache" },
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "call-1",
					toolName: "lookup",
					output: { type: "text", value: "Tool result" },
					providerOptions: breakpointProviderOptions,
				},
			],
		},
	];
}

async function captureRequest(options: {
	apiMode: "completions" | "responses";
	promptCaching: "gpt-5.6-explicit" | "none";
	model: string;
	protocol?: "openai-chat" | "openai-responses";
	metadata?: { sessionId?: string };
	messages: ModelMessage[];
}): Promise<Record<string, unknown>> {
	let requestBody: Record<string, unknown> | undefined;
	const client = new OpenAIClient({
		apiKey: "sk-test",
		apiMode: options.apiMode,
		promptCaching: options.promptCaching,
		customFetch: async (_input, init) => {
			requestBody = JSON.parse(String(init?.body));
			return new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		},
	});

	try {
		const stream = await client.chat({
			model: options.model,
			protocol: options.protocol,
			messages: options.messages,
			metadata: options.metadata,
			thinkingEffort: "high",
			allowSystemInMessages: true,
			cancellationToken,
		});
		for await (const _part of stream) {
			// Drain the minimal mocked event stream.
		}
	} catch {
		// The wire body is captured before the intentionally incomplete stream ends.
	}

	if (!requestBody) {
		throw new Error("OpenAI request was not captured");
	}
	return requestBody;
}

describe("OpenAI explicit prompt caching wire requests", () => {
	it("serializes Responses options and a structured tool-result breakpoint", async () => {
		const messages = markedContinuationMessages();
		const requestBody = await captureRequest({
			apiMode: "responses",
			promptCaching: "gpt-5.6-explicit",
			model: "gpt-5.6-sol",
			metadata: { sessionId: "conversation-1" },
			messages,
		});

		expect(requestBody).toMatchObject({
			model: "gpt-5.6-sol",
			prompt_cache_key: "conversation-1",
			prompt_cache_options: { mode: "explicit", ttl: "30m" },
			store: false,
			reasoning: { effort: "high", summary: "detailed" },
		});
		expect(breakpointPaths(requestBody)).toEqual([
			"input[0].content[0].prompt_cache_breakpoint",
			"input[1].content[0].prompt_cache_breakpoint",
			"input[4].output[0].prompt_cache_breakpoint",
		]);
		expect(requestBody.input).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "function_call_output",
					output: [
						{
							type: "input_text",
							text: "Tool result",
							prompt_cache_breakpoint: { mode: "explicit" },
						},
					],
				}),
			]),
		);
		// Request-time normalization must not mutate persisted/caller messages.
		expect(messages[4]).toMatchObject({
			content: [{ output: { type: "text", value: "Tool result" } }],
		});
	});

	it("serializes Chat breakpoints, including the tool-role text block", async () => {
		const requestBody = await captureRequest({
			apiMode: "responses",
			promptCaching: "gpt-5.6-explicit",
			model: "gpt-5.6-terra",
			protocol: "openai-chat",
			metadata: { sessionId: "conversation-chat" },
			messages: markedContinuationMessages(),
		});

		expect(requestBody).toMatchObject({
			prompt_cache_key: "conversation-chat",
			prompt_cache_options: { mode: "explicit", ttl: "30m" },
			reasoning_effort: "high",
		});
		expect(breakpointPaths(requestBody)).toEqual([
			"messages[0].content[0].prompt_cache_breakpoint",
			"messages[1].content[0].prompt_cache_breakpoint",
			"messages[4].content[0].prompt_cache_breakpoint",
		]);
		expect(requestBody.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "tool",
					content: [
						{
							type: "text",
							text: "Tool result",
							prompt_cache_breakpoint: { mode: "explicit" },
						},
					],
				}),
			]),
		);
	});

	it("keeps explicit mode but strips key and markers when session metadata is absent", async () => {
		const messages = markedContinuationMessages();
		const requestBody = await captureRequest({
			apiMode: "responses",
			promptCaching: "gpt-5.6-explicit",
			model: "gpt-5.6-luna",
			messages,
		});

		expect(requestBody.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
		expect(requestBody).not.toHaveProperty("prompt_cache_key");
		expect(breakpointPaths(requestBody)).toEqual([]);
		expect(messages[0].providerOptions).toEqual(breakpointProviderOptions);
	});

	it.each([
		["gpt-5.5", "gpt-5.6-explicit"],
		["gpt-5.6-sol", "none"],
	] as const)(
		"does not send cache fields for model %s with capability %s",
		async (model, capability) => {
			const requestBody = await captureRequest({
				apiMode: "responses",
				promptCaching: capability,
				model,
				metadata: { sessionId: "conversation-1" },
				messages: [{ role: "user", content: "Hello" }],
			});

			expect(requestBody).not.toHaveProperty("prompt_cache_key");
			expect(requestBody).not.toHaveProperty("prompt_cache_options");
		},
	);
});
