/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { APICallError } from "@ai-sdk/provider";
import { jsonSchema } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock only `streamText` and the Google provider factory so the tests below
// can drive `GeminiClient.chat()` end-to-end and inspect the exact toolset
// handed to the SDK. Everything else — the provider-tool merge, the
// expired-interaction retry, and the platform stream conversion — runs for
// real.
interface StreamTextArgs {
	tools?: Record<string, unknown>;
	toolChoice?: string;
}

const { streamText, googleSearch } = vi.hoisted(() => ({
	streamText: vi.fn<(args: StreamTextArgs) => unknown>(),
	googleSearch: vi.fn(() => ({ __providerTool: "google_search" })),
}));
vi.mock("ai", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	streamText,
}));
vi.mock("@ai-sdk/google", () => ({
	createGoogleGenerativeAI: vi.fn(() => ({
		interactions: vi.fn(() => ({})),
		tools: { googleSearch },
	})),
}));

import type { AiToolWithJsonSchema, CancellationToken } from "../../types";
import { GeminiClient } from "../GeminiClient";

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

function localTool(): AiToolWithJsonSchema {
	return { inputSchema: jsonSchema({ type: "object", properties: {} }) };
}

function emptyStream() {
	return {
		fullStream: (async function* () {
			// No parts.
		})(),
	};
}

/** Assistant message carrying a Google interaction ID, forcing chaining. */
function chainedMessages() {
	return [
		{
			role: "assistant" as const,
			content: "Earlier answer",
			providerOptions: { providerMetadata: { google: { interactionId: "v1_prev" } } },
		},
		{ role: "user" as const, content: "Follow-up" },
	];
}

/** Stream whose first read throws an expired-interaction API error. */
function expiredInteractionStream() {
	return {
		fullStream: (async function* () {
			throw new APICallError({
				message: "Bad request",
				url: "https://generativelanguage.googleapis.com/v1beta/interactions",
				requestBodyValues: {},
				statusCode: 400,
				responseBody: "The interaction has expired",
			});
		})(),
	};
}

function streamTextArgs(callIndex: number): StreamTextArgs {
	return streamText.mock.calls[callIndex][0];
}

describe("GeminiClient web search toolset", () => {
	beforeEach(() => {
		streamText.mockReset();
		googleSearch.mockClear();
	});

	it("attaches google_search alongside local tools when webSearchEnabled is set", async () => {
		streamText.mockReturnValueOnce(emptyStream());
		const local = localTool();

		const client = new GeminiClient("test-key");
		const stream = await client.chat({
			model: "gemini-3.8-flash",
			messages: [{ role: "user", content: "Hello" }],
			tools: { readFile: local },
			webSearchEnabled: true,
			cancellationToken,
		});
		for await (const _part of stream) {
			// Drain.
		}

		expect(googleSearch).toHaveBeenCalledOnce();
		const args = streamTextArgs(0);
		expect(args.tools?.readFile).toBe(local);
		expect(args.tools?.google_search).toEqual({ __providerTool: "google_search" });
		expect(args.toolChoice).toBe("auto");
	});

	it("attaches google_search as the only tool when no local tools exist", async () => {
		streamText.mockReturnValueOnce(emptyStream());

		const client = new GeminiClient("test-key");
		const stream = await client.chat({
			model: "gemini-3.8-flash",
			messages: [{ role: "user", content: "Hello" }],
			webSearchEnabled: true,
			cancellationToken,
		});
		for await (const _part of stream) {
			// Drain.
		}

		const args = streamTextArgs(0);
		expect(args.tools?.google_search).toBeDefined();
		expect(args.toolChoice).toBe("auto");
	});

	it("passes local tools through untouched when webSearchEnabled is not set", async () => {
		streamText.mockReturnValueOnce(emptyStream());
		const localTools = { readFile: localTool() };

		const client = new GeminiClient("test-key");
		const stream = await client.chat({
			model: "gemini-3.8-flash",
			messages: [{ role: "user", content: "Hello" }],
			tools: localTools,
			cancellationToken,
		});
		for await (const _part of stream) {
			// Drain.
		}

		expect(googleSearch).not.toHaveBeenCalled();
		expect(streamTextArgs(0).tools).toBe(localTools);
	});

	it("rejects when a local tool occupies the reserved google_search key", async () => {
		const client = new GeminiClient("test-key");
		await expect(
			client.chat({
				model: "gemini-3.8-flash",
				messages: [{ role: "user", content: "Hello" }],
				tools: { google_search: localTool() },
				webSearchEnabled: true,
				cancellationToken,
			}),
		).rejects.toThrowError(/local tool named "google_search"/);
	});

	it("keeps google_search on the expired-interaction retry", async () => {
		streamText.mockReturnValueOnce(expiredInteractionStream());
		streamText.mockReturnValueOnce(emptyStream());

		const client = new GeminiClient("test-key");
		const stream = await client.chat({
			model: "gemini-3.8-flash",
			messages: chainedMessages(),
			webSearchEnabled: true,
			cancellationToken,
		});
		for await (const _part of stream) {
			// Drain — drives the first stream into the expired-interaction error
			// and the retry to completion.
		}

		expect(streamText).toHaveBeenCalledTimes(2);
		// Both the chained first attempt and the fresh-interaction retry carry
		// the provider tool.
		expect(streamTextArgs(0).tools?.google_search).toBeDefined();
		expect(streamTextArgs(1).tools?.google_search).toBeDefined();
	});
});
