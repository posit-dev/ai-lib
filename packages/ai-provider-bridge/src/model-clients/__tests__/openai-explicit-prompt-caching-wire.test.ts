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

/**
 * The exact message shape `prepareClassifierRequest` produces for an eligible
 * OpenAI-route classifier mid-turn: marked system message, then a block-split
 * user message — unmarked header, two transcript blocks carrying the read
 * anchor (previous request's write position) and the write anchor (transcript
 * end), and the unmarked evaluation section.
 */
function classifierShapedMessages(): ModelMessage[] {
	return [
		{
			role: "system",
			content: "You are a classifier.",
			providerOptions: breakpointProviderOptions,
		},
		{
			role: "user",
			content: [
				{
					type: "text",
					text: "<workspace>\n(none)\n</workspace>\n\n--- Conversation ---\n",
				},
				{
					type: "text",
					text: "<user_message>Refactor the parser</user_message>",
					providerOptions: breakpointProviderOptions,
				},
				{
					type: "text",
					text: '\n<tool_call>bash({"command":"ls"})</tool_call>',
					providerOptions: breakpointProviderOptions,
				},
				{
					type: "text",
					text: '--- Tool call to evaluate ---\nedit({"file_path":"src/a.ts"})\n\nShould this tool call be allowed? Respond with JSON only.',
				},
			],
		},
	];
}

async function captureRequest(options: {
	apiMode: "completions" | "responses";
	usesExplicitPromptCaching?: boolean;
	model: string;
	protocol?: "openai-chat" | "openai-responses";
	metadata?: { sessionId?: string };
	messages: ModelMessage[];
}): Promise<Record<string, unknown>> {
	let requestBody: Record<string, unknown> | undefined;
	const client = new OpenAIClient({
		apiKey: "sk-test",
		apiMode: options.apiMode,
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
			usesExplicitPromptCaching: options.usesExplicitPromptCaching,
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
			usesExplicitPromptCaching: true,
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
			usesExplicitPromptCaching: true,
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

	it("serializes the classifier block-split user message with breakpoints on the marked transcript blocks (Responses)", async () => {
		const requestBody = await captureRequest({
			apiMode: "responses",
			usesExplicitPromptCaching: true,
			model: "gpt-5.6-terra",
			metadata: { sessionId: "conversation-1:classifier" },
			messages: classifierShapedMessages(),
		});

		expect(breakpointPaths(requestBody)).toEqual([
			"input[0].content[0].prompt_cache_breakpoint",
			"input[1].content[1].prompt_cache_breakpoint",
			"input[1].content[2].prompt_cache_breakpoint",
		]);
		// The per-call evaluation section survives unmarked.
		const userContent = (requestBody.input as Array<{ content: Array<Record<string, unknown>> }>)[1]
			.content;
		expect(userContent).toHaveLength(4);
		expect(userContent[0]).not.toHaveProperty("prompt_cache_breakpoint");
		expect(userContent[3]).not.toHaveProperty("prompt_cache_breakpoint");
		expect(userContent[3].text).toContain("--- Tool call to evaluate ---");
	});

	it("serializes the classifier block-split user message with breakpoints on the marked transcript blocks (Chat)", async () => {
		const requestBody = await captureRequest({
			apiMode: "responses",
			usesExplicitPromptCaching: true,
			model: "gpt-5.6-terra",
			protocol: "openai-chat",
			metadata: { sessionId: "conversation-1:classifier" },
			messages: classifierShapedMessages(),
		});

		expect(breakpointPaths(requestBody)).toEqual([
			"messages[0].content[0].prompt_cache_breakpoint",
			"messages[1].content[1].prompt_cache_breakpoint",
			"messages[1].content[2].prompt_cache_breakpoint",
		]);
		const userContent = (
			requestBody.messages as Array<{ content: Array<Record<string, unknown>> }>
		)[1].content;
		expect(userContent).toHaveLength(4);
		expect(userContent[0]).not.toHaveProperty("prompt_cache_breakpoint");
		expect(userContent[3]).not.toHaveProperty("prompt_cache_breakpoint");
		expect(userContent[3].text).toContain("--- Tool call to evaluate ---");
	});

	it("bounds an over-long subagent session ID to a stable 64-char cache key", async () => {
		// A subagent's session ID is `rootUUID:subUUID` — 73 chars, over OpenAI's
		// 64-char `prompt_cache_key` limit, which used to 400 the request.
		const sessionId = "3f8b1c2d-4e5a-6b7c-8d9e-0f1a2b3c4d5e:9a8b7c6d-5e4f-3a2b-1c0d-9e8f7a6b5c4d";
		expect(sessionId).toHaveLength(73);

		const first = await captureRequest({
			apiMode: "responses",
			usesExplicitPromptCaching: true,
			model: "gpt-5.6-sol",
			metadata: { sessionId },
			messages: markedContinuationMessages(),
		});
		const second = await captureRequest({
			apiMode: "responses",
			usesExplicitPromptCaching: true,
			model: "gpt-5.6-sol",
			metadata: { sessionId },
			messages: markedContinuationMessages(),
		});

		const cacheKey = first.prompt_cache_key;
		expect(typeof cacheKey).toBe("string");
		expect(String(cacheKey).length).toBeLessThanOrEqual(64);
		// Same conversation must reuse the same key across turns.
		expect(second.prompt_cache_key).toBe(cacheKey);
		// Breakpoints stay eligible: the key is present, just projected.
		expect(breakpointPaths(first)).toEqual([
			"input[0].content[0].prompt_cache_breakpoint",
			"input[1].content[0].prompt_cache_breakpoint",
			"input[4].output[0].prompt_cache_breakpoint",
		]);
	});

	it("keeps explicit mode but strips key and markers when session metadata is absent", async () => {
		const messages = markedContinuationMessages();
		const requestBody = await captureRequest({
			apiMode: "responses",
			usesExplicitPromptCaching: true,
			model: "gpt-5.6-luna",
			messages,
		});

		expect(requestBody.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
		expect(requestBody).not.toHaveProperty("prompt_cache_key");
		expect(breakpointPaths(requestBody)).toEqual([]);
		expect(messages[0].providerOptions).toEqual(breakpointProviderOptions);
	});

	it.each([
		["false", false],
		["absent", undefined],
	] as const)(
		"sends no cache fields and strips markers when the param is %s",
		async (_label, usesExplicitPromptCaching) => {
			const messages = markedContinuationMessages();
			const requestBody = await captureRequest({
				apiMode: "responses",
				usesExplicitPromptCaching,
				model: "gpt-5.6-sol",
				metadata: { sessionId: "conversation-1" },
				messages,
			});

			expect(requestBody).not.toHaveProperty("prompt_cache_key");
			expect(requestBody).not.toHaveProperty("prompt_cache_options");
			expect(breakpointPaths(requestBody)).toEqual([]);
			// The strip is request-local; caller messages keep their markers.
			expect(messages[0].providerOptions).toEqual(breakpointProviderOptions);
		},
	);
});
