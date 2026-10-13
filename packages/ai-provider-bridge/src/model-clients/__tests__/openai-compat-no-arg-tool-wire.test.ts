/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema, streamText, tool } from "ai";
import { describe, expect, it } from "vitest";

import { createOpenAICompatibleFetchMiddleware } from "../openai-compat-fetch";

/**
 * A standard OpenAI Chat Completions stream for a tool with no parameters sends
 * `arguments: ""` on the first delta and `arguments: "{}"` on a later one. The
 * SDK concatenates argument deltas per tool-call index, so the middleware must
 * not rewrite the empty first delta: doing so produced `{}{}` and a JSON parse
 * failure for every no-arg tool call (e.g. `ExitMode` on Microsoft Foundry).
 *
 * These tests drive the real `@ai-sdk/openai` chat model and `streamText`, so a
 * dependency bump that changes argument accumulation or empty-input handling
 * fails here.
 */
function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
	return JSON.stringify({
		id: "chatcmpl_1",
		object: "chat.completion.chunk",
		created: 1790444153,
		model: "gpt-5.4",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	});
}

function toolCallStart(index: number, id: string, name: string) {
	return { index, id, type: "function", function: { name, arguments: "" } };
}

function toolCallArgs(index: number, args: string) {
	return { index, function: { arguments: args } };
}

async function toolCallParts(sseChunks: string[]) {
	const wire = async () =>
		new Response(sseChunks.map((c) => `data: ${c}\n\n`).join("") + "data: [DONE]\n\n", {
			headers: { "content-type": "text/event-stream" },
		});
	const fetch = createOpenAICompatibleFetchMiddleware("Microsoft Foundry", "key")(wire);
	const provider = createOpenAI({ apiKey: "key", baseURL: "https://example.invalid", fetch });
	const result = streamText({
		model: provider.chat("gpt-5.4"),
		prompt: "Exit plan mode and check the weather in Paris.",
		tools: {
			ExitMode: tool({
				inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
			}),
			get_weather: tool({
				inputSchema: jsonSchema<{ city: string }>({
					type: "object",
					properties: { city: { type: "string" } },
					required: ["city"],
				}),
			}),
		},
	});
	const collected = [];
	for await (const part of result.fullStream) {
		collected.push(part);
	}
	return collected;
}

function summarize(collected: Awaited<ReturnType<typeof toolCallParts>>) {
	return {
		errors: collected.filter((p) => p.type === "error" || p.type === "tool-error"),
		toolCalls: collected.flatMap((p) =>
			p.type === "tool-call"
				? [{ toolName: p.toolName, input: p.input, invalid: p.invalid ?? false }]
				: [],
		),
	};
}

describe("createOpenAICompatibleFetch — no-parameter tool arguments", () => {
	it("passes `{}` for a no-arg tool streamed as `` then `{}`, alongside a parallel tool", async () => {
		const collected = await toolCallParts([
			chunk({
				role: "assistant",
				content: null,
				tool_calls: [toolCallStart(0, "call_1", "ExitMode")],
			}),
			chunk({ tool_calls: [toolCallArgs(0, "{}")] }),
			chunk({ tool_calls: [toolCallStart(1, "call_2", "get_weather")] }),
			chunk({ tool_calls: [toolCallArgs(1, '{"ci')] }),
			chunk({ tool_calls: [toolCallArgs(1, 'ty":"Par')] }),
			chunk({ tool_calls: [toolCallArgs(1, 'is"}')] }),
			chunk({}, "tool_calls"),
		]);

		expect(summarize(collected)).toEqual({
			errors: [],
			toolCalls: [
				{ toolName: "ExitMode", input: {}, invalid: false },
				{ toolName: "get_weather", input: { city: "Paris" }, invalid: false },
			],
		});
	});

	it("passes `{}` for a no-arg tool whose only argument delta is empty", async () => {
		const collected = await toolCallParts([
			chunk({
				role: "assistant",
				content: null,
				tool_calls: [toolCallStart(0, "call_1", "ExitMode")],
			}),
			chunk({}, "tool_calls"),
		]);

		expect(summarize(collected)).toEqual({
			errors: [],
			toolCalls: [{ toolName: "ExitMode", input: {}, invalid: false }],
		});
	});
});
