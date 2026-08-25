/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Regression test for issue #2016: replaying a history that contains
 * OpenAI-wire tool-call IDs (e.g. Kimi K3's `<toolName>:<counter>` format)
 * to an Anthropic-wire model must not trip Anthropic's `tool_use.id`
 * validation (`^[a-zA-Z0-9_-]+$`). The Anthropic-wire clients sanitize
 * outbound IDs send-side.
 */

import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRawFetchCapture } from "../../../tests/helpers/raw-fetch-capture";
import { registerAnthropicProvider } from "../../providers/anthropic-provider";
import { ProviderRegistry } from "../../providers/ProviderRegistry";
import type { CancellationToken, Logger } from "../../types";
import { PositAiClient } from "../PositAiClient";

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

const logger: Logger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
	trace: () => {},
};

const ANTHROPIC_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function successfulAnthropicStreamResponse(): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_test",
				model: "claude-haiku-4-5",
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

async function consumeStream(streamPromise: Promise<AsyncIterable<unknown>>): Promise<void> {
	const stream = await streamPromise;
	for await (const _part of stream) {
		// Drain the successful mocked event stream.
	}
}

/** Kimi K3 history: `ls:0` repeats across turns (counter resets per turn). */
function kimiHistory(): ModelMessage[] {
	return [
		{ role: "user", content: "What's in this directory?" },
		{
			role: "assistant",
			content: [{ type: "tool-call", toolCallId: "ls:0", toolName: "ls", input: {} }],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "ls:0",
					toolName: "ls",
					output: { type: "text", value: "file.txt" },
				},
			],
		},
		{ role: "user", content: "And in the parent?" },
		{
			role: "assistant",
			content: [{ type: "tool-call", toolCallId: "ls:0", toolName: "ls", input: {} }],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "ls:0",
					toolName: "ls",
					output: { type: "text", value: "other.txt" },
				},
			],
		},
	];
}

function collectToolIds(body: Record<string, unknown>): { useIds: string[]; resultIds: string[] } {
	const useIds: string[] = [];
	const resultIds: string[] = [];
	for (const message of body.messages as Array<{ content: unknown }>) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content as Array<Record<string, unknown>>) {
			if (part.type === "tool_use") useIds.push(part.id as string);
			if (part.type === "tool_result") resultIds.push(part.tool_use_id as string);
		}
	}
	return { useIds, resultIds };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("PositAiClient Anthropic-wire tool-call ID sanitization", () => {
	const client = new PositAiClient("token", "https://posit.ai", "test-agent", logger);

	it("sends only pattern-conforming, unique, paired tool IDs", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const capture = createRawFetchCapture(async (_input: RequestInfo | URL, init?: RequestInit) => {
			requestBody = JSON.parse(String(init?.body));
			return successfulAnthropicStreamResponse();
		});
		vi.stubGlobal("fetch", capture.mock);

		await consumeStream(
			client.chat({
				model: "claude-haiku-4-5",
				messages: kimiHistory(),
				cancellationToken,
			}),
		);

		expect(requestBody).toBeDefined();
		const { useIds, resultIds } = collectToolIds(requestBody!);

		// No raw Kimi IDs on the wire; everything matches Anthropic's pattern.
		expect(useIds).toHaveLength(2);
		expect(resultIds).toHaveLength(2);
		for (const id of [...useIds, ...resultIds]) {
			expect(id).toMatch(ANTHROPIC_ID_PATTERN);
			expect(id).not.toContain(":");
		}

		// Duplicate originals across turns become unique per request...
		expect(new Set(useIds).size).toBe(2);

		// ...and each result still pairs with its call.
		expect(resultIds).toEqual(useIds);
	});
});

describe("registered AnthropicClient sanitizer observability", () => {
	it("routes sanitizer warnings through the provider logger", async () => {
		const warningLogger: Logger & { warn: ReturnType<typeof vi.fn> } = {
			...logger,
			warn: vi.fn(),
		};
		const registry = new ProviderRegistry(warningLogger);
		registerAnthropicProvider(registry, warningLogger);
		const client = registry.getClientForProvider("anthropic", {
			type: "apikey",
			apiKey: "token",
			baseUrl: "https://api.anthropic.com/v1",
		});
		if (!client) throw new Error("expected registered Anthropic client");

		const capture = createRawFetchCapture(async () => successfulAnthropicStreamResponse());
		vi.stubGlobal("fetch", capture.mock);

		await consumeStream(
			client.chat({
				model: "claude-haiku-4-5",
				messages: kimiHistory(),
				cancellationToken,
			}),
		);

		expect(warningLogger.warn.mock.calls.flat().join(" ")).toContain("ls:0");
	});
});
