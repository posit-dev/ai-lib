/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Wire regression for the auto-mode classifier's block-split user message on
 * the Anthropic-wire transports (direct Messages API and Bedrock InvokeModel):
 * the ephemeral breakpoints must serialize onto the system block and the
 * marked transcript blocks (the read anchor at the previous request's write
 * position plus the write anchor at the transcript end), and nowhere else. The
 * unrelated marker namespaces core also places on the part (`bedrock`,
 * `openai`) must not leak onto the Anthropic wire.
 */

import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

const { resolveBedrockTransport } = vi.hoisted(() => ({
	resolveBedrockTransport: vi.fn(async () => ({
		useFipsEndpoint: false,
		runtimeBaseUrl: "https://bedrock-runtime.us-east-2.amazonaws.com",
		mantleEnabled: true,
	})),
}));

vi.mock("../../providers/bedrock-transport", () => ({ resolveBedrockTransport }));

import { createRawFetchCapture } from "../../../tests/helpers/raw-fetch-capture";
import type { CancellationToken } from "../../types";
import { AnthropicClient } from "../AnthropicClient";
import { BedrockClient } from "../BedrockClient";

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

/** The marker shape core places on the classifier's system message and part 1. */
const classifierProviderOptions = {
	anthropic: { cacheControl: { type: "ephemeral" } },
	bedrock: { cachePoint: { type: "default" } },
};

/**
 * The exact message shape `prepareClassifierRequest` produces for an
 * Anthropic-route classifier mid-turn: marked system message, then a
 * block-split user message — unmarked header, two transcript blocks carrying
 * the read anchor (previous request's write position) and the write anchor
 * (transcript end), and the unmarked evaluation section.
 */
function classifierShapedMessages(): ModelMessage[] {
	return [
		{
			role: "system",
			content: "You are a classifier.",
			providerOptions: classifierProviderOptions,
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
					providerOptions: classifierProviderOptions,
				},
				{
					type: "text",
					text: '\n<tool_call>bash({"command":"ls"})</tool_call>',
					providerOptions: classifierProviderOptions,
				},
				{
					type: "text",
					text: '--- Tool call to evaluate ---\nedit({"file_path":"src/a.ts"})\n\nShould this tool call be allowed? Respond with JSON only.',
				},
			],
		},
	];
}

/** Recursively collect JSON paths of every `cache_control` key in the body. */
function cacheControlPaths(value: unknown, path = ""): string[] {
	if (Array.isArray(value)) {
		return value.flatMap((item, index) => cacheControlPaths(item, `${path}[${index}]`));
	}
	if (value === null || typeof value !== "object") {
		return [];
	}
	const paths: string[] = [];
	for (const [key, child] of Object.entries(value)) {
		const childPath = path ? `${path}.${key}` : key;
		if (key === "cache_control") {
			paths.push(childPath);
		} else {
			paths.push(...cacheControlPaths(child, childPath));
		}
	}
	return paths;
}

function successfulAnthropicStreamResponse(): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_test",
				model: "claude-sonnet-4-5",
				role: "assistant",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 0 },
		},
		{ type: "message_stop" },
	];
	const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function stubFetchCapture(): { body: () => Record<string, unknown> } {
	let requestBody: Record<string, unknown> | undefined;
	const capture = createRawFetchCapture(async (_input: RequestInfo | URL, init?: RequestInit) => {
		requestBody = JSON.parse(String(init?.body));
		return successfulAnthropicStreamResponse();
	});
	vi.stubGlobal("fetch", capture.mock);
	return {
		body: () => {
			if (!requestBody) throw new Error("request was not captured");
			return requestBody;
		},
	};
}

async function consumeStream(streamPromise: Promise<AsyncIterable<unknown>>): Promise<void> {
	const stream = await streamPromise;
	for await (const _part of stream) {
		// Drain the successful mocked event stream.
	}
}

/** Assert the classifier breakpoint contract on an Anthropic-wire body. */
function expectClassifierBreakpoints(body: Record<string, unknown>): void {
	// Breakpoints on the system block and the two marked transcript blocks
	// (read anchor + write anchor) only — 3 of Anthropic's 4-breakpoint budget.
	expect(cacheControlPaths(body)).toEqual([
		"system[0].cache_control",
		"messages[0].content[1].cache_control",
		"messages[0].content[2].cache_control",
	]);

	const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
	expect(messages[0].content).toHaveLength(4);
	expect(messages[0].content[0]).not.toHaveProperty("cache_control");
	expect(messages[0].content[1].cache_control).toEqual({ type: "ephemeral" });
	expect(messages[0].content[2].cache_control).toEqual({ type: "ephemeral" });
	expect(messages[0].content[3]).not.toHaveProperty("cache_control");
	// The evaluation section survives intact after the marked prefix.
	expect(messages[0].content[3].text).toContain("--- Tool call to evaluate ---");

	// Unrelated marker namespaces must not leak onto the Anthropic wire.
	const serialized = JSON.stringify(body);
	expect(serialized).not.toContain("cachePoint");
	expect(serialized).not.toContain("prompt_cache_breakpoint");
}

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.AWS_BEARER_TOKEN_BEDROCK;
});

describe("AnthropicClient classifier cache breakpoints", () => {
	const client = new AnthropicClient({ apiKey: "sk-ant-test" });

	it("serializes the breakpoints on the marked transcript blocks, leaving header and evaluation unmarked", async () => {
		const capture = stubFetchCapture();

		await consumeStream(
			client.chat({
				model: "claude-sonnet-4-5",
				messages: classifierShapedMessages(),
				maxOutputTokens: 256,
				allowSystemInMessages: true,
				cancellationToken,
			}),
		);

		expectClassifierBreakpoints(capture.body());
	});
});

describe("BedrockClient Anthropic-route classifier cache breakpoints", () => {
	const client = new BedrockClient({
		region: "us-east-2",
		accessKeyId: "AKIDEXAMPLE",
		secretAccessKey: "secret",
	});

	it("serializes the breakpoints on the marked transcript blocks on the InvokeModel transport", async () => {
		const capture = stubFetchCapture();

		await consumeStream(
			client.chat({
				model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
				messages: classifierShapedMessages(),
				maxOutputTokens: 256,
				allowSystemInMessages: true,
				cancellationToken,
			}),
		);

		expectClassifierBreakpoints(capture.body());
	});
});
