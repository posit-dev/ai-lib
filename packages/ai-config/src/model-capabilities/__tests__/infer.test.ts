/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { customModelSchema } from "../../schema.js";
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

	it("passes gemma thinking levels through the positai family", () => {
		const caps = inferModelCapabilities("positai", "google/gemma-4-27b-it");
		expect(caps.thinkingEffortLevels).toEqual(["off", "on"]);
	});

	it("resolves Baseten Model APIs models through the positai family", () => {
		const glm = inferModelCapabilities("positai", "zai-org/GLM-5.2");
		expect(glm.family).toBe("glm");
		expect(glm.thinkingEffortLevels).toEqual(["off", "on"]);
		expect(glm.supportsImages).toBe(false);
		expect(glm.maxContextLength).toBe(256_000);

		const kimi = inferModelCapabilities("positai", "moonshotai/Kimi-K2.7-Code");
		expect(kimi.family).toBe("kimi");
		expect(kimi.thinkingEffortLevels).toEqual(["off", "on"]);
		// The table lists image media types without the flag; the derivation
		// must lift supportsImages for this vision-capable model.
		expect(kimi.supportsImages).toBe(true);
		expect(kimi.maxContextLength).toBe(262_000);
	});

	it("omits requiresChatTemplateKwargs so the result fits a models.custom entry", () => {
		// The Gemma table sets this runtime-only flag, but the strict custom-model
		// schema rejects it; inferModelCapabilities must not surface it.
		const caps = inferModelCapabilities("positai", "google/gemma-4-27b-it");
		expect(caps).not.toHaveProperty("requiresChatTemplateKwargs");
	});

	it("produces a spread that validates against the strict customModelSchema", () => {
		// The migration use case: { id, name, ...inferModelCapabilities(...) } must
		// parse. Gemma is the regression case — its table sets a key the schema
		// rejects. Cover a representative id per provider family.
		for (const [providerId, modelId] of [
			["positai", "google/gemma-4-27b-it"],
			["positai", "zai-org/GLM-5.2"],
			["positai", "moonshotai/Kimi-K2.7-Code"],
			["anthropic", "claude-opus-4-8"],
			["openai", "gpt-4o"],
			["gemini", "gemini-2.5-pro"],
			["deepseek", "deepseek-chat"],
			["snowflake-cortex", "claude-sonnet-4-5"],
			["snowflake-cortex", "openai-gpt-5.2"],
			["google-vertex", "gemini-2.5-pro"],
			["openai-compatible", "totally-unknown-model"],
		] as const) {
			const result = customModelSchema.safeParse({
				id: modelId,
				name: modelId,
				...inferModelCapabilities(providerId, modelId),
			});
			expect(result.success, `${providerId}/${modelId}: ${result.error?.message}`).toBe(true);
		}
	});

	it("caps snowflake claude ids to Snowflake's limits, not the upstream table", () => {
		// The Anthropic table gives Opus 4.7 a 1M window / 128k output; Snowflake
		// Cortex serves it at 200k / 16k (snowflake-cortex-provider.ts).
		const caps = inferModelCapabilities("snowflake-cortex", "claude-opus-4-7");
		expect(caps.protocol).toBe("anthropic-messages");
		expect(caps.maxContextLength).toBe(200_000);
		expect(caps.maxInputTokens).toBe(200_000);
		expect(caps.maxOutputTokens).toBe(16_384);
		expect(caps.supportsToolResultImages).toBe(true);
		expect(caps.family).toBe("claude-4.7"); // still borrowed from the table
	});

	it("caps snowflake openai ids and disables tool-result images", () => {
		const caps = inferModelCapabilities("snowflake-cortex", "openai-gpt-5.2");
		expect(caps.protocol).toBe("openai-chat");
		expect(caps.maxContextLength).toBe(128_000);
		expect(caps.maxInputTokens).toBe(128_000);
		expect(caps.maxOutputTokens).toBe(16_384);
		expect(caps.supportsImages).toBe(true); // gpt-5.x accepts images
		expect(caps.supportsToolResultImages).toBe(false);
	});

	it("infers google-vertex gemini models from the gemini table", () => {
		const caps = inferModelCapabilities("google-vertex", "gemini-2.5-pro");
		expect(caps.maxContextLength).toBe(1_000_000);
		expect(caps.supportsImages).toBe(true);
		expect(caps.family).toBe("gemini-2.5");
	});

	it("infers google-vertex anthropic partner models, stripping resource prefixes", () => {
		const caps = inferModelCapabilities(
			"google-vertex",
			"publishers/anthropic/models/claude-opus-4-7",
		);
		expect(caps.family).toBe("claude-4.7");
		expect(caps.maxContextLength).toBe(1_000_000);
		expect(caps.supportsImages).toBe(true);
	});
});
