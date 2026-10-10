/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { APICallError } from "@ai-sdk/provider";
import { jsonSchema } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock only `streamText` and the Google provider factory so the tests below
// can drive `GeminiClient.chat()` end-to-end and inspect the exact toolset
// handed to the SDK. Everything else — the provider-tool merge, the
// expired-interaction retry, and the platform stream conversion — runs for
// real. The retry tests additionally route `streamText` to the real SDK over
// a mock language model, so provider failures arrive through the SDK's own
// error channel.
interface StreamTextArgs {
	tools?: Record<string, unknown>;
	toolChoice?: string;
	providerOptions?: { google?: Record<string, unknown> };
}

const { streamText, googleSearch, interactionsModel } = vi.hoisted(() => ({
	streamText: vi.fn<(args: StreamTextArgs) => unknown>(),
	googleSearch: vi.fn<() => unknown>(() => ({ __providerTool: "google_search" })),
	interactionsModel: { current: {} as unknown },
}));
vi.mock("ai", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	streamText,
}));
vi.mock("@ai-sdk/google", () => ({
	createGoogleGenerativeAI: vi.fn(() => ({
		interactions: vi.fn(() => interactionsModel.current),
		tools: { googleSearch },
	})),
}));

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";

import type { AiToolWithJsonSchema, CancellationToken, LMStreamPart } from "../../types";
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

/** Google's rejection of a request chained to an expired interaction. */
function expiredInteractionError() {
	return new APICallError({
		message: "Bad request",
		url: "https://generativelanguage.googleapis.com/v1beta/interactions",
		requestBodyValues: {},
		statusCode: 400,
		responseBody: "The interaction has expired",
	});
}

/** Model stream parts for a short text answer, optionally ending in an error. */
function textStream(text: string, error?: unknown) {
	const parts: LanguageModelV3StreamPart[] = [
		{ type: "stream-start", warnings: [] },
		{ type: "text-start", id: "t1" },
		{ type: "text-delta", id: "t1", delta: text },
	];
	if (error !== undefined) {
		parts.push({ type: "error", error });
	} else {
		parts.push(
			{ type: "text-end", id: "t1" },
			{
				type: "finish",
				finishReason: { unified: "stop", raw: "STOP" },
				usage: {
					inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
					outputTokens: { total: 1, text: 1, reasoning: undefined },
				},
			},
		);
	}
	return {
		stream: new ReadableStream<LanguageModelV3StreamPart>({
			start(controller) {
				for (const part of parts) controller.enqueue(part);
				controller.close();
			},
		}),
	};
}

/** Route `streamText` to the real SDK over a mock Interactions model. */
async function useRealSdk(doStream: MockLanguageModelV3["doStream"]) {
	const { streamText: realStreamText } = await vi.importActual<typeof import("ai")>("ai");
	// The hoisted mock is typed narrowly for the arg-inspection tests above.
	streamText.mockImplementation((args) =>
		realStreamText(args as Parameters<typeof realStreamText>[0]),
	);
	const model = new MockLanguageModelV3({ provider: "google.interactions", doStream });
	interactionsModel.current = model;
	googleSearch.mockReturnValueOnce({ type: "provider", id: "google.google_search", args: {} });
	return model;
}

async function drain(stream: AsyncIterable<LMStreamPart>): Promise<LMStreamPart[]> {
	const parts: LMStreamPart[] = [];
	for await (const part of stream) parts.push(part);
	return parts;
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
});

describe("GeminiClient expired-interaction retry", () => {
	beforeEach(() => {
		streamText.mockReset();
		googleSearch.mockClear();
	});
	afterEach(() => {
		interactionsModel.current = {};
	});

	it("retries a rejected chained request with a fresh interaction, keeping google_search", async () => {
		const expired = expiredInteractionError();
		let call = 0;
		const model = await useRealSdk(async () => {
			call++;
			if (call === 1) throw expired;
			return textStream("Fresh answer");
		});

		const client = new GeminiClient("test-key");
		const parts = await drain(
			await client.chat({
				model: "gemini-3.8-flash",
				messages: chainedMessages(),
				webSearchEnabled: true,
				cancellationToken,
			}),
		);

		// The SDK reports the rejection as an error part, which the retry
		// consumes: the caller sees one clean stream from the fresh request.
		expect(parts.filter((p) => p.type === "error")).toEqual([]);
		expect(parts.filter((p) => p.type === "start")).toHaveLength(1);
		expect(parts.flatMap((p) => (p.type === "text-delta" ? [p.text] : []))).toEqual([
			"Fresh answer",
		]);

		expect(model.doStreamCalls).toHaveLength(2);
		const [chained, fresh] = model.doStreamCalls;
		expect(chained.providerOptions?.google?.previousInteractionId).toBe("v1_prev");
		expect(fresh.providerOptions?.google?.previousInteractionId).toBeUndefined();
		// Both attempts carry the hosted search tool.
		for (const request of model.doStreamCalls) {
			expect(request.tools).toContainEqual(
				expect.objectContaining({ type: "provider", name: "google_search" }),
			);
		}
	});

	it("does not retry an expired-interaction error that arrives after content", async () => {
		const expired = expiredInteractionError();
		const model = await useRealSdk(async () => textStream("Partial", expired));

		const client = new GeminiClient("test-key");
		const parts = await drain(
			await client.chat({
				model: "gemini-3.8-flash",
				messages: chainedMessages(),
				webSearchEnabled: true,
				cancellationToken,
			}),
		);

		expect(model.doStreamCalls).toHaveLength(1);
		expect(parts.flatMap((p) => (p.type === "error" ? [p.error] : []))).toEqual([expired]);
	});

	it("retries when the chained stream throws before any content", async () => {
		streamText.mockReturnValueOnce({
			fullStream: (async function* () {
				throw expiredInteractionError();
			})(),
		});
		streamText.mockReturnValueOnce(emptyStream());

		const client = new GeminiClient("test-key");
		await drain(
			await client.chat({
				model: "gemini-3.8-flash",
				messages: chainedMessages(),
				webSearchEnabled: true,
				cancellationToken,
			}),
		);

		expect(streamText).toHaveBeenCalledTimes(2);
		expect(streamTextArgs(0).providerOptions?.google?.previousInteractionId).toBe("v1_prev");
		expect(streamTextArgs(1).providerOptions?.google?.previousInteractionId).toBeUndefined();
		expect(streamTextArgs(1).tools?.google_search).toBeDefined();
	});
});
