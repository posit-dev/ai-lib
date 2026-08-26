/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { customModelSchema } from "../../schema.js";
import { getGeminiModelCapabilities } from "../gemini-helpers.js";
import { inferModelCapabilities } from "../infer.js";

type HostedGemmaCase = {
	name: string;
	modelId: string;
};

const HOSTED_GEMMA_CASES = [
	{ name: "dense hosted Gemma", modelId: "gemma-4-31b-it" },
	{ name: "mixture-of-experts hosted Gemma", modelId: "gemma-4-26b-a4b-it" },
] satisfies readonly HostedGemmaCase[];

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

	it("gives the bare GPT-5.6 alias the Sol long-context pricing limit", () => {
		const alias = inferModelCapabilities("openai", "gpt-5.6");
		const sol = inferModelCapabilities("openai", "gpt-5.6-sol");
		expect(alias.maxContextLength).toBe(272_000);
		expect(alias.maxInputTokens).toBe(sol.maxInputTokens);
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
		expect(caps.family).toBe("gpt-4o"); // OpenAI table matched after the strip
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

		const kimiK3 = inferModelCapabilities("positai", "moonshotai/Kimi-K3");
		expect(kimiK3.maxContextLength).toBe(250_000);
		expect(kimiK3.maxInputTokens).toBe(250_000);
		expect(kimiK3.maxOutputTokens).toBe(131_072);

		const deepSeek = inferModelCapabilities("positai", "deepseek-ai/DeepSeek-V4-Flash-0731");
		expect(deepSeek.family).toBe("deepseek-v4");
		expect(deepSeek.thinkingEffortLevels).toEqual(["off", "low", "high", "max"]);
		expect(deepSeek.supportsImages).toBe(false);
		expect(deepSeek.maxContextLength).toBe(200_000);
		expect(deepSeek.maxInputTokens).toBe(200_000);
		expect(deepSeek.maxOutputTokens).toBe(384_000);
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

	it("serves snowflake Claude models with their Anthropic output limits", () => {
		// Cortex routes Claude through the Anthropic Messages API with the
		// upstream limits: the Anthropic table gives Opus 4.7 a 1M window and
		// 128k output, and input shares the window with output.
		const caps = inferModelCapabilities("snowflake-cortex", "claude-opus-4-7");
		expect(caps.protocol).toBe("anthropic-messages");
		expect(caps.maxContextLength).toBe(1_000_000);
		expect(caps.maxOutputTokens).toBe(128_000);
		expect(caps.maxInputTokens).toBe(1_000_000 - 128_000);
		expect(caps.supportsToolResultImages).toBe(true);
		expect(caps.family).toBe("claude-4.7"); // still borrowed from the table

		// Chat Completions models likewise use the upstream OpenAI table limits.
		const openai = inferModelCapabilities("snowflake-cortex", "openai-gpt-5.2");
		expect(openai.protocol).toBe("openai-chat");
		expect(openai.maxContextLength).toBe(272_000);
		expect(openai.maxOutputTokens).toBe(128_000);
		expect(openai.maxInputTokens).toBe(272_000 - 128_000);
		expect(openai.supportsImages).toBe(true); // gpt-5.x accepts images
		expect(openai.supportsToolResultImages).toBe(false);
	});

	it("falls back to conservative windows for snowflake ids outside the catalog", () => {
		const claude = inferModelCapabilities("snowflake-cortex", "claude-opus-9");
		expect(claude.protocol).toBe("anthropic-messages");
		expect(claude.maxContextLength).toBe(200_000);
		// No explicit Anthropic rule matches, so the helper's optimistic 64k
		// default is rejected in favor of the conservative fallback.
		expect(claude.maxOutputTokens).toBe(16_384);
		expect(claude.maxInputTokens).toBe(200_000 - 16_384);
		expect(claude.supportsToolResultImages).toBe(true);

		const other = inferModelCapabilities("snowflake-cortex", "openai-gpt-9");
		expect(other.protocol).toBe("openai-chat");
		expect(other.maxContextLength).toBe(128_000);
		expect(other.maxOutputTokens).toBe(16_384); // conservative fallback
		expect(other.maxInputTokens).toBe(128_000 - 16_384);
		expect(other.supportsToolResultImages).toBe(false);
	});

	it.each(HOSTED_GEMMA_CASES)(
		"resolves a $name through the gemini endpoint composition",
		({ modelId }) => {
			const caps = inferModelCapabilities("gemini", modelId);
			expect(caps.family).toBe("gemma-4");
			expect(caps.maxInputTokens).toBe(262_144);
			expect(caps.maxContextLength).toBe(262_144);
			expect(caps.maxOutputTokens).toBe(32_768);
			// Product-level vocabulary; the bridge maps off→minimal on the wire.
			expect(caps.thinkingEffortLevels).toEqual(["off", "high"]);
			expect(caps.supportsTools).toBe(true);
			expect(caps.supportsImages).toBe(true);
			expect(caps.supportsToolResultImages).toBe(true);
			expect(caps.supportedInputMediaTypes).toEqual([
				"image/png",
				"image/jpeg",
				"image/gif",
				"image/webp",
				"application/pdf",
			]);
		},
	);

	it("gives gemini-3.7 models low/medium/high only (3.7-flash rejects minimal)", () => {
		const caps = inferModelCapabilities("gemini", "gemini-3.7-flash");
		expect(caps.family).toBe("gemini-3");
		expect(caps.thinkingEffortLevels).toEqual(["low", "medium", "high"]);
		// The generic 3.x rule still adds minimal for other 3.x models
		expect(inferModelCapabilities("gemini", "gemini-3.6-flash").thinkingEffortLevels).toEqual([
			"minimal",
			"low",
			"medium",
			"high",
		]);
	});

	it("keeps hosted-Gemma semantics out of google-vertex and the shared gemini table", () => {
		// Vertex does not serve the hosted-Gemma contract: a gemma id falls
		// through to the conservative baseline.
		const vertex = inferModelCapabilities("google-vertex", "gemma-4-31b-it");
		expect(vertex.family).toBeUndefined();
		expect(vertex.thinkingEffortLevels).toBeUndefined();
		expect(vertex.maxContextLength).toBe(128_000);

		// The shared Gemini-family table (also used by provider-agnostic core
		// inference and VS Code LM discovery) still rejects bare gemma ids.
		expect(getGeminiModelCapabilities("gemma-4-31b-it")).toBeUndefined();
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
