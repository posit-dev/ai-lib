/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
	getGeminiInteractionsProfile,
	isInteractionsEligible,
} from "../model-capabilities/gemini-helpers";
import {
	buildInteractionsOptions,
	extractPreviousInteractionId,
	filterUnsignedReasoning,
} from "../model-clients/GeminiClient";

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------
describe("isInteractionsEligible", () => {
	it("accepts 2.5 chat models", () => {
		expect(isInteractionsEligible("gemini-2.5-pro")).toBe(true);
		expect(isInteractionsEligible("gemini-2.5-flash")).toBe(true);
		expect(isInteractionsEligible("gemini-2.5-flash-lite")).toBe(true);
	});

	it("accepts known 3.x chat models", () => {
		expect(isInteractionsEligible("gemini-3-flash-preview")).toBe(true);
		expect(isInteractionsEligible("gemini-3.1-pro-preview")).toBe(true);
		expect(isInteractionsEligible("gemini-3.1-flash-lite-preview")).toBe(true);
		expect(isInteractionsEligible("gemini-3.5-flash")).toBe(true);
	});

	it("rejects excluded models (fail-closed)", () => {
		expect(isInteractionsEligible("gemini-3-pro-preview")).toBe(false);
		expect(isInteractionsEligible("gemini-2.0-flash")).toBe(false);
		expect(isInteractionsEligible("gemini-1.5-pro")).toBe(false);
		expect(isInteractionsEligible("gemini-2.5-flash-image")).toBe(false);
		expect(isInteractionsEligible("unknown-model")).toBe(false);
	});
});

describe("getGeminiInteractionsProfile", () => {
	it("2.5 Pro: low/medium/high only", () => {
		const pro = getGeminiInteractionsProfile("gemini-2.5-pro");
		expect(pro).toBeDefined();
		expect(pro!.thinkingLevels).toEqual(["low", "medium", "high"]);
	});

	it("2.5 Flash: low/medium/high only (no minimal, no off)", () => {
		const flash = getGeminiInteractionsProfile("gemini-2.5-flash");
		expect(flash).toBeDefined();
		expect(flash!.thinkingLevels).toEqual(["low", "medium", "high"]);
	});

	it("2.5 Flash-Lite: low/medium/high only (no minimal on Interactions API)", () => {
		const lite = getGeminiInteractionsProfile("gemini-2.5-flash-lite");
		expect(lite).toBeDefined();
		expect(lite!.thinkingLevels).toEqual(["low", "medium", "high"]);
	});

	it("3-flash-preview: supports minimal thinkingLevel", () => {
		const flash3 = getGeminiInteractionsProfile("gemini-3-flash-preview");
		expect(flash3).toBeDefined();
		expect(flash3!.thinkingLevels).toEqual(["minimal", "low", "medium", "high"]);
	});

	it("3.5-flash: supports minimal thinkingLevel", () => {
		const flash35 = getGeminiInteractionsProfile("gemini-3.5-flash");
		expect(flash35).toBeDefined();
		expect(flash35!.thinkingLevels).toEqual(["minimal", "low", "medium", "high"]);
	});

	it("returns undefined for ineligible models", () => {
		expect(getGeminiInteractionsProfile("gemini-2.0-flash")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Interaction ID Extraction
// ---------------------------------------------------------------------------
describe("extractPreviousInteractionId", () => {
	it("returns null for empty messages", () => {
		const result = extractPreviousInteractionId([]);
		expect(result.previousInteractionId).toBeNull();
		expect(result.deltaStartIndex).toBe(0);
	});

	it("returns null when no assistant messages have interactionId", () => {
		const messages: ModelMessage[] = [
			{ role: "user", content: [{ type: "text", text: "hello" }] },
			{ role: "assistant", content: [{ type: "text", text: "hi" }] },
		];
		const result = extractPreviousInteractionId(messages);
		expect(result.previousInteractionId).toBeNull();
	});

	it("extracts message-level interactionId", () => {
		const messages: ModelMessage[] = [
			{ role: "user", content: [{ type: "text", text: "hello" }] },
			{
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				providerOptions: {
					providerMetadata: {
						google: { interactionId: "int-123" },
					},
				},
			},
			{ role: "user", content: [{ type: "text", text: "followup" }] },
		];
		const result = extractPreviousInteractionId(messages);
		expect(result.previousInteractionId).toBe("int-123");
		expect(result.deltaStartIndex).toBe(2); // after the assistant message
	});

	it("extracts part-level interactionId from reasoning parts", () => {
		const messages: ModelMessage[] = [
			{
				role: "assistant",
				content: [
					{
						type: "reasoning",
						text: "thinking...",
						providerOptions: {
							google: { interactionId: "int-456", signature: "sig" },
						},
					},
					{ type: "text", text: "answer" },
				],
			},
		];
		const result = extractPreviousInteractionId(messages);
		expect(result.previousInteractionId).toBe("int-456");
		expect(result.deltaStartIndex).toBe(1);
	});

	it("returns the most recent interactionId", () => {
		const messages: ModelMessage[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: "first" }],
				providerOptions: {
					providerMetadata: {
						google: { interactionId: "old-id" },
					},
				},
			},
			{ role: "user", content: [{ type: "text", text: "next" }] },
			{
				role: "assistant",
				content: [{ type: "text", text: "second" }],
				providerOptions: {
					providerMetadata: {
						google: { interactionId: "new-id" },
					},
				},
			},
			{ role: "user", content: [{ type: "text", text: "third" }] },
		];
		const result = extractPreviousInteractionId(messages);
		expect(result.previousInteractionId).toBe("new-id");
		expect(result.deltaStartIndex).toBe(3);
	});

	it("treats compaction boundary as hard stop", () => {
		const messages: ModelMessage[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: "compaction summary" }],
				providerOptions: {
					providerMetadata: {
						google: { interactionId: "compaction-id" },
						positai: { isCompactionSummary: true },
					},
				},
			},
			{ role: "user", content: [{ type: "text", text: "hello after compact" }] },
		];
		const result = extractPreviousInteractionId(messages);
		expect(result.previousInteractionId).toBeNull();
		expect(result.deltaStartIndex).toBe(0);
	});

	it("chains from post-compaction response (not the summary)", () => {
		const messages: ModelMessage[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: "compaction summary" }],
				providerOptions: {
					providerMetadata: {
						google: { interactionId: "compaction-id" },
						positai: { isCompactionSummary: true },
					},
				},
			},
			{ role: "user", content: [{ type: "text", text: "first post-compaction" }] },
			{
				role: "assistant",
				content: [{ type: "text", text: "fresh response" }],
				providerOptions: {
					providerMetadata: {
						google: { interactionId: "fresh-id" },
					},
				},
			},
			{ role: "user", content: [{ type: "text", text: "second post-compaction" }] },
		];
		const result = extractPreviousInteractionId(messages);
		expect(result.previousInteractionId).toBe("fresh-id");
		expect(result.deltaStartIndex).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// Signature Filter
// ---------------------------------------------------------------------------
describe("filterUnsignedReasoning", () => {
	it("passes through non-assistant messages unchanged", () => {
		const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
		expect(filterUnsignedReasoning(messages)).toEqual(messages);
	});

	it("retains reasoning with google.signature", () => {
		const messages: ModelMessage[] = [
			{
				role: "assistant",
				content: [
					{
						type: "reasoning",
						text: "thinking...",
						providerOptions: { google: { signature: "abc123" } },
					},
					{ type: "text", text: "answer" },
				],
			},
		];
		const result = filterUnsignedReasoning(messages);
		expect(result).toHaveLength(1);
		expect((result[0].content as unknown[]).length).toBe(2);
	});

	it("drops reasoning without google.signature", () => {
		const messages: ModelMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "unsigned thought" },
					{ type: "text", text: "answer" },
				],
			},
		];
		const result = filterUnsignedReasoning(messages);
		expect(result).toHaveLength(1);
		const content = result[0].content as unknown[];
		expect(content).toHaveLength(1);
		expect((content[0] as { type: string }).type).toBe("text");
	});

	it("drops reasoning with legacy thoughtSignature (not google.signature)", () => {
		const messages: ModelMessage[] = [
			{
				role: "assistant",
				content: [
					{
						type: "reasoning",
						text: "legacy thought",
						providerOptions: { anthropic: { thoughtSignature: "sig" } },
					},
					{ type: "text", text: "answer" },
				],
			},
		];
		const result = filterUnsignedReasoning(messages);
		expect(result).toHaveLength(1);
		const content = result[0].content as unknown[];
		expect(content).toHaveLength(1);
		expect((content[0] as { type: string }).type).toBe("text");
	});

	it("drops entire message when all parts are unsigned reasoning", () => {
		const messages: ModelMessage[] = [
			{
				role: "assistant",
				content: [{ type: "reasoning", text: "only thought" }],
			},
		];
		const result = filterUnsignedReasoning(messages);
		expect(result).toHaveLength(0);
	});

	it("retains tool-call parts even without signature", () => {
		const messages: ModelMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "unsigned" },
					{
						type: "tool-call",
						toolCallId: "tc1",
						toolName: "search",
						args: {},
					},
				],
			},
		];
		const result = filterUnsignedReasoning(messages);
		expect(result).toHaveLength(1);
		const content = result[0].content as unknown[];
		expect(content).toHaveLength(1);
		expect((content[0] as { type: string }).type).toBe("tool-call");
	});

	it("handles string content (no parts to filter)", () => {
		const messages: ModelMessage[] = [{ role: "assistant", content: "plain text response" }];
		expect(filterUnsignedReasoning(messages)).toEqual(messages);
	});
});

// ---------------------------------------------------------------------------
// Options Builder
// ---------------------------------------------------------------------------
describe("buildInteractionsOptions", () => {
	it("always includes store:true", () => {
		const result = buildInteractionsOptions({
			thinkingEffort: undefined,
			modelId: "gemini-2.5-pro",
			previousInteractionId: null,
		});
		expect(result.google.store).toBe(true);
	});

	it("omits thinkingLevel when effort is 'off'", () => {
		const result = buildInteractionsOptions({
			thinkingEffort: "off",
			modelId: "gemini-2.5-flash",
			previousInteractionId: null,
		});
		expect(result.google).not.toHaveProperty("thinkingLevel");
	});

	it("omits thinkingLevel when effort is undefined", () => {
		const result = buildInteractionsOptions({
			thinkingEffort: undefined,
			modelId: "gemini-2.5-pro",
			previousInteractionId: null,
		});
		expect(result.google).not.toHaveProperty("thinkingLevel");
	});

	it("includes previousInteractionId when provided", () => {
		const result = buildInteractionsOptions({
			thinkingEffort: "medium",
			modelId: "gemini-2.5-pro",
			previousInteractionId: "prev-id",
		});
		expect(result.google.previousInteractionId).toBe("prev-id");
	});

	it("includes thinkingSummaries when thinking is active", () => {
		const result = buildInteractionsOptions({
			thinkingEffort: "high",
			modelId: "gemini-2.5-pro",
			previousInteractionId: null,
		});
		expect(result.google.thinkingSummaries).toBe("auto");
	});

	describe("validates against per-model profile", () => {
		it("accepts levels in the model's profile", () => {
			const result = buildInteractionsOptions({
				thinkingEffort: "low",
				modelId: "gemini-2.5-pro",
				previousInteractionId: null,
			});
			expect(result.google.thinkingLevel).toBe("low");
		});

		it("clamps unrecognized effort to 'medium'", () => {
			const result = buildInteractionsOptions({
				thinkingEffort: "ultra",
				modelId: "gemini-2.5-pro",
				previousInteractionId: null,
			});
			expect(result.google.thinkingLevel).toBe("medium");
		});

		it("rejects 'minimal' for 2.5 models (not in their profile)", () => {
			const result = buildInteractionsOptions({
				thinkingEffort: "minimal",
				modelId: "gemini-2.5-flash",
				previousInteractionId: null,
			});
			// minimal is not valid for 2.5 Flash — clamped to medium
			expect(result.google.thinkingLevel).toBe("medium");
		});

		it("accepts 'minimal' for 3.x Flash models", () => {
			const result = buildInteractionsOptions({
				thinkingEffort: "minimal",
				modelId: "gemini-3-flash-preview",
				previousInteractionId: null,
			});
			expect(result.google.thinkingLevel).toBe("minimal");
		});
	});
});
