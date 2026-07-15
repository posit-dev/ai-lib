/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { inferModelCapabilities } from "../infer.js";

describe("inferModelCapabilities", () => {
	it("returns the generic baseline for an unknown model on an unknown provider", () => {
		expect(inferModelCapabilities("openai-compatible", "totally-unknown-model")).toEqual({
			maxContextLength: 128_000,
			supportsTools: true,
			supportsImages: false,
			supportsToolResultImages: false,
			supportsWebSearch: false,
			maxInputTokens: 128_000,
			maxOutputTokens: 16_384,
		});
	});

	it("applies anthropic family inference above the baseline", () => {
		const caps = inferModelCapabilities("anthropic", "claude-opus-4-8");
		expect(caps.maxContextLength).toBe(1_000_000);
		expect(caps.maxOutputTokens).toBe(128_000);
		expect(caps.maxInputTokens).toBe(1_000_000 - 128_000);
		expect(caps.supportsTools).toBe(true);
		expect(caps.supportsToolResultImages).toBe(true);
		expect(caps.family).toBe("claude-4.8");
	});

	it("uses the anthropic table for bedrock ids", () => {
		const caps = inferModelCapabilities("bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
		expect(caps.family).toBe("claude-4.5");
		expect(caps.maxContextLength).toBe(200_000);
		expect(caps.maxOutputTokens).toBe(16_000);
		expect(caps.maxInputTokens).toBe(200_000 - 16_000);
	});

	it("derives supportsImages when a table lists image media types but omits the flag", () => {
		// The anthropic and gemini tables set supportedInputMediaTypes but never
		// supportsImages; the derivation must lift the flag above the baseline.
		expect(inferModelCapabilities("anthropic", "claude-opus-4-8").supportsImages).toBe(true);
		expect(inferModelCapabilities("gemini", "gemini-2.5-pro").supportsImages).toBe(true);
	});

	it("derives openai maxInputTokens from the context window", () => {
		const caps = inferModelCapabilities("openai", "gpt-4o");
		expect(caps.maxContextLength).toBe(128_000);
		expect(caps.maxOutputTokens).toBe(16_384);
		expect(caps.maxInputTokens).toBe(128_000 - 16_384);
	});

	it("maps the deepseek table, treating the input limit as the window", () => {
		const caps = inferModelCapabilities("deepseek", "deepseek-chat");
		expect(caps.maxInputTokens).toBe(1_000_000);
		expect(caps.maxContextLength).toBe(1_000_000);
		expect(caps.supportsTools).toBe(true);
		expect(caps.supportsImages).toBe(false);
	});

	it("resolves snowflake claude ids to the anthropic-messages protocol", () => {
		expect(inferModelCapabilities("snowflake-cortex", "claude-sonnet-4-5").protocol).toBe(
			"anthropic-messages",
		);
	});

	it("resolves snowflake non-claude ids to openai-chat and strips the openai- prefix", () => {
		const caps = inferModelCapabilities("snowflake-cortex", "openai-gpt-4o");
		expect(caps.protocol).toBe("openai-chat");
		expect(caps.maxContextLength).toBe(128_000); // gpt-4o table matched after strip
		expect(caps.family).toBe("gpt-4o");
	});

	it("sets no protocol for non-snowflake providers", () => {
		expect(inferModelCapabilities("anthropic", "claude-sonnet-4-5").protocol).toBeUndefined();
	});

	it("passes gemma flags through the positai family", () => {
		const caps = inferModelCapabilities("positai", "google/gemma-4-27b-it");
		expect(caps.requiresChatTemplateKwargs).toBe(true);
		expect(caps.thinkingEffortLevels).toEqual(["off", "on"]);
	});
});
