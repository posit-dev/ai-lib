/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { LanguageModelUsage } from "ai";
import { describe, expect, it, vi } from "vitest";

// Mock only `streamText` (and the SDK factory it needs) so the wiring test
// below can drive `GeminiClient.chat()` end-to-end over a canned stream.
// Everything else — the platform stream conversion, abort plumbing, and the
// hoist itself — runs for real.
const { streamText } = vi.hoisted(() => ({ streamText: vi.fn() }));
vi.mock("ai", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	streamText,
}));
vi.mock("@ai-sdk/google", () => ({
	createGoogleGenerativeAI: vi.fn(() => ({ interactions: vi.fn(() => ({})) })),
}));

import type { CancellationToken, LMStreamPart } from "../../types";
import { GeminiClient, hoistRawUsageMetadata } from "../GeminiClient";

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

const interactionsRawUsage = {
	total_input_tokens: 11945,
	total_output_tokens: 40,
	total_thought_tokens: 11,
	total_cached_tokens: 0,
	total_tokens: 11996,
};

type FinishStepPart = Extract<LMStreamPart, { type: "finish-step" }>;

function finishStepPart(overrides?: {
	usage?: LanguageModelUsage;
	providerMetadata?: FinishStepPart["providerMetadata"];
}): FinishStepPart {
	return {
		type: "finish-step",
		response: { id: "v1_abc" },
		usage: overrides?.usage ?? {
			inputTokens: 11945,
			inputTokenDetails: {
				noCacheTokens: 11945,
				cacheReadTokens: 0,
				cacheWriteTokens: undefined,
			},
			outputTokens: 51,
			outputTokenDetails: { textTokens: 40, reasoningTokens: 11 },
			totalTokens: 11996,
			raw: interactionsRawUsage,
		},
		finishReason: "stop",
		rawFinishReason: "STOP",
		providerMetadata: overrides?.providerMetadata ?? {
			google: { interactionId: "v1_abc", serviceTier: "standard" },
		},
	};
}

describe("hoistRawUsageMetadata", () => {
	it("copies usage.raw into google.usageMetadata on finish-step parts", () => {
		const result = hoistRawUsageMetadata(finishStepPart());
		expect(result.type).toBe("finish-step");
		if (result.type !== "finish-step") return;

		expect(result.providerMetadata?.google).toEqual({
			interactionId: "v1_abc",
			serviceTier: "standard",
			usageMetadata: interactionsRawUsage,
		});
		// Original part is not mutated
		const original = finishStepPart();
		hoistRawUsageMetadata(original);
		expect(original.providerMetadata?.google?.usageMetadata).toBeUndefined();
	});

	it("passes non-finish-step parts through unchanged", () => {
		const textDelta: LMStreamPart = {
			type: "text-delta",
			id: "1",
			text: "hello",
		};
		expect(hoistRawUsageMetadata(textDelta)).toBe(textDelta);
	});

	it("passes finish-step parts without raw usage through unchanged", () => {
		const part = finishStepPart({
			usage: {
				inputTokens: 10,
				inputTokenDetails: {
					noCacheTokens: 10,
					cacheReadTokens: undefined,
					cacheWriteTokens: undefined,
				},
				outputTokens: 5,
				outputTokenDetails: { textTokens: 5, reasoningTokens: undefined },
				totalTokens: 15,
			},
		});
		expect(hoistRawUsageMetadata(part)).toBe(part);
	});

	it("does not overwrite an existing usageMetadata", () => {
		const existing = { promptTokenCount: 1 };
		const part = finishStepPart({
			providerMetadata: { google: { usageMetadata: existing } },
		});
		const result = hoistRawUsageMetadata(part);
		expect(result).toBe(part);
	});
});

describe("GeminiClient.chat raw-usage hoist wiring", () => {
	// Enters through chat() so this fails if the withRawUsageMetadata wrapper
	// is ever dropped from the client's stream pipeline — the pure-function
	// tests above cannot catch that.
	it("emits finish-step parts with usage.raw hoisted into google.usageMetadata", async () => {
		streamText.mockReturnValueOnce({
			fullStream: (async function* () {
				yield finishStepPart();
			})(),
		});

		const client = new GeminiClient("test-key");
		const stream = await client.chat({
			model: "gemini-2.5-flash",
			messages: [{ role: "user", content: "Hello" }],
			cancellationToken,
		});

		const parts: LMStreamPart[] = [];
		for await (const part of stream) {
			parts.push(part);
		}

		const finish = parts.find((part) => part.type === "finish-step");
		expect(finish).toBeDefined();
		if (!finish || finish.type !== "finish-step") return;
		expect(finish.providerMetadata?.google?.usageMetadata).toEqual(interactionsRawUsage);
	});
});
