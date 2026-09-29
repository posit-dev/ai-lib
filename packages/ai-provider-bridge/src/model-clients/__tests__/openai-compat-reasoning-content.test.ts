/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema, streamText, tool } from "ai";
import { describe, expect, it } from "vitest";

import { createOpenAICompatibleFetchMiddleware } from "../openai-compat-fetch";

/**
 * Databricks streams reasoning models (e.g. `databricks-gpt-oss-120b`) with
 * `delta.content` as an array of `{type: "reasoning", summary: [...]}` blocks
 * instead of a string. The AI SDK rejects such a chunk whole — and Databricks
 * sends a tool call's arguments in the same chunk as its reasoning, so the tool
 * call completed with `{}` input. The tool-call and reasoning chunks below are
 * captured from the wire (ids shortened); the `{type: "text"}` part is modeled
 * on Databricks' non-streaming content shape.
 */
function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
	return JSON.stringify({
		id: "chatcmpl_1",
		object: "chat.completion.chunk",
		created: 1790444153,
		model: "gpt-oss-120b-080525",
		choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
	});
}

function reasoning(text: string) {
	return [{ type: "reasoning", summary: [{ type: "summary_text", text }] }];
}

const toolCallStream = [
	chunk({
		role: "assistant",
		content: "",
		tool_calls: [
			{
				id: "call_1",
				index: 0,
				type: "function",
				function: { name: "get_weather", arguments: "" },
			},
		],
	}),
	chunk({
		content: reasoning('We need to call the get_weather function with city "Paris".'),
		tool_calls: [{ index: 0, function: { arguments: '{\n  "city": "Paris"\n}' } }],
	}),
	chunk({ content: "", tool_calls: [{ index: 0, function: { arguments: "" } }] }, "tool_calls"),
];

const textStream = [
	chunk({ role: "assistant", content: "" }),
	chunk({ content: reasoning("We need") }),
	chunk({ content: reasoning(" to say hello.") }),
	chunk({ content: [{ type: "text", text: "Hello" }] }),
	chunk({ content: "!" }),
	chunk({ content: "" }, "stop"),
];

function run(sseChunks: string[]) {
	const wire = async () =>
		new Response(sseChunks.map((c) => `data: ${c}\n\n`).join("") + "data: [DONE]\n\n", {
			headers: { "content-type": "text/event-stream" },
		});
	const fetch = createOpenAICompatibleFetchMiddleware("Databricks", "key")(wire);
	const provider = createOpenAI({ apiKey: "key", baseURL: "https://example.invalid", fetch });
	return streamText({
		model: provider.chat("databricks-gpt-oss-120b"),
		prompt: "What's the weather in Paris?",
		tools: {
			get_weather: tool({
				inputSchema: jsonSchema<{ city: string }>({
					type: "object",
					properties: { city: { type: "string" } },
					required: ["city"],
				}),
			}),
		},
	});
}

async function parts(sseChunks: string[]) {
	const result = run(sseChunks);
	const collected = [];
	for await (const part of result.fullStream) {
		collected.push(part);
	}
	return collected;
}

describe("createOpenAICompatibleFetch — array delta.content", () => {
	it("keeps tool arguments that share a chunk with reasoning content", async () => {
		const collected = await parts(toolCallStream);

		expect(collected.filter((p) => p.type === "error")).toEqual([]);
		const toolCalls = collected.flatMap((p) => (p.type === "tool-call" ? [p.input] : []));
		expect(toolCalls).toEqual([{ city: "Paris" }]);
	});

	it("keeps text parts and drops reasoning parts without stream errors", async () => {
		const collected = await parts(textStream);

		expect(collected.filter((p) => p.type === "error")).toEqual([]);
		const text = collected.flatMap((p) => (p.type === "text-delta" ? [p.text] : [])).join("");
		expect(text).toBe("Hello!");
	});

	it("keeps output_text parts and ignores parts without string text", async () => {
		const collected = await parts([
			chunk({ role: "assistant", content: "" }),
			chunk({ content: [{ type: "output_text", text: "Hi" }] }),
			chunk({ content: [{ type: "text", text: 42 }] }),
			chunk({ content: "" }, "stop"),
		]);

		expect(collected.filter((p) => p.type === "error")).toEqual([]);
		const text = collected.flatMap((p) => (p.type === "text-delta" ? [p.text] : [])).join("");
		expect(text).toBe("Hi");
	});
});
