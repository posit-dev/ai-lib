/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenAICompatibleFetch } from "../openai-compat-fetch";

const URL_UNDER_TEST = "https://adb-123.4.azuredatabricks.net/serving-endpoints/chat/completions";

/**
 * A reasoning delta as captured from the Databricks Unity AI Gateway for a
 * Bedrock-hosted Anthropic model: the summary text is empty and the thinking
 * itself is an opaque signature.
 */
const CLAUDE_REASONING_EVENT = {
	model: "us.anthropic.claude-sonnet-5",
	choices: [
		{
			delta: {
				role: "assistant",
				content: [
					{
						type: "reasoning",
						summary: [{ type: "summary_text", text: "", signature: "EoMCCnIIEBABGAIqQCKMye" }],
					},
				],
			},
			index: 0,
			finish_reason: null,
		},
	],
	usage: { prompt_tokens: 14, completion_tokens: null },
	object: "chat.completion.chunk",
	id: "msg_bdrk_2o2h32fycuayck53hdyg7y7wralr4bj73pbp774hfl6h22zejvha",
	created: 1786483287,
};

/** The same deviation from gpt-oss, which puts visible text in `summary`. */
const GPT_OSS_REASONING_EVENT = {
	model: "gpt-oss-120b-080525",
	choices: [
		{
			delta: {
				content: [
					{ type: "reasoning", summary: [{ type: "summary_text", text: "The user asks simple" }] },
				],
			},
			index: 0,
			finish_reason: null,
		},
	],
	object: "chat.completion.chunk",
	id: "chatcmpl-oss",
	created: 1786483300,
};

/** A well-formed text delta, which the gateway sends as a plain string. */
const TEXT_EVENT = {
	model: "us.anthropic.claude-sonnet-5",
	choices: [{ delta: { role: "assistant", content: "Hi there," }, index: 0, finish_reason: null }],
	object: "chat.completion.chunk",
	id: "msg_bdrk_2o2h32fycuayck53hdyg7y7wralr4bj73pbp774hfl6h22zejvha",
	created: 1786483287,
};

function sse(...events: unknown[]): string {
	return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
}

/** Serve `body` as an SSE response, cut into the given byte-length slices. */
function stubStreamingFetch(body: string, sliceAt?: number): void {
	const bytes = new TextEncoder().encode(body);
	const slices =
		sliceAt === undefined ? [bytes] : [bytes.subarray(0, sliceAt), bytes.subarray(sliceAt)];
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							for (const slice of slices) {
								controller.enqueue(slice);
							}
							controller.close();
						},
					}),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				),
		),
	);
}

/** Read the transformed stream back into parsed `data:` payloads. */
async function transformedEvents(): Promise<unknown[]> {
	const compatFetch = createOpenAICompatibleFetch("Databricks", "dapi-test-token");
	const response = await compatFetch(URL_UNDER_TEST, { method: "POST" });
	const text = await response.text();
	return text
		.split("\n")
		.filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
		.map((line) => JSON.parse(line.slice(6)) as unknown);
}

function contentOf(event: unknown): unknown {
	const choices = (event as { choices: { delta: { content?: unknown } }[] }).choices;
	return choices[0].delta.content;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("openai-compatible SSE transforms: block-array content", () => {
	it("collapses a Databricks reasoning delta to an empty string", async () => {
		stubStreamingFetch(sse(CLAUDE_REASONING_EVENT));

		const [event] = await transformedEvents();

		expect(contentOf(event)).toBe("");
	});

	it("leaves every other field on the reasoning chunk untouched", async () => {
		stubStreamingFetch(sse(CLAUDE_REASONING_EVENT));

		const [event] = await transformedEvents();

		expect(event).toEqual({
			...CLAUDE_REASONING_EVENT,
			choices: [
				{
					...CLAUDE_REASONING_EVENT.choices[0],
					delta: { role: "assistant", content: "" },
				},
			],
		});
	});

	it("collapses a gpt-oss reasoning delta, dropping its visible summary", async () => {
		stubStreamingFetch(sse(GPT_OSS_REASONING_EVENT));

		const [event] = await transformedEvents();

		expect(contentOf(event)).toBe("");
	});

	it("keeps the text of `text` blocks, which the non-streaming shape uses", async () => {
		const event = {
			...TEXT_EVENT,
			choices: [
				{
					...TEXT_EVENT.choices[0],
					delta: {
						role: "assistant",
						content: [
							{ type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] },
							{ type: "text", text: "2 + 2 = " },
							{ type: "text", text: "4." },
						],
					},
				},
			],
		};
		stubStreamingFetch(sse(event));

		const [transformed] = await transformedEvents();

		expect(contentOf(transformed)).toBe("2 + 2 = 4.");
	});

	it("leaves unrecognized content blocks untouched so the SDK fails loudly", async () => {
		const event = {
			...TEXT_EVENT,
			choices: [
				{
					...TEXT_EVENT.choices[0],
					delta: {
						role: "assistant",
						content: [{ type: "future-output", text: "Do not silently discard this" }],
					},
				},
			],
		};
		stubStreamingFetch(sse(event));

		const [transformed] = await transformedEvents();

		expect(transformed).toEqual(event);
	});

	it("passes string content through unchanged", async () => {
		stubStreamingFetch(sse(TEXT_EVENT));

		const [event] = await transformedEvents();

		expect(event).toEqual(TEXT_EVENT);
	});

	it("preserves answer text when a reasoning event is split across network chunks", async () => {
		// Cut mid-JSON inside the reasoning event so the transform only sees a
		// partial line on its first read. Parsing that partial line would drop
		// the event and, with it, the text that follows.
		const body = sse(CLAUDE_REASONING_EVENT, TEXT_EVENT);
		const sliceAt = body.indexOf("signature") + 4;
		stubStreamingFetch(body, sliceAt);

		const events = await transformedEvents();

		expect(events.map(contentOf)).toEqual(["", "Hi there,"]);
	});

	it("emits a terminating [DONE] sentinel unchanged", async () => {
		stubStreamingFetch(sse(CLAUDE_REASONING_EVENT));

		const compatFetch = createOpenAICompatibleFetch("Databricks", "dapi-test-token");
		const text = await (await compatFetch(URL_UNDER_TEST, { method: "POST" })).text();

		expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
	});
});
