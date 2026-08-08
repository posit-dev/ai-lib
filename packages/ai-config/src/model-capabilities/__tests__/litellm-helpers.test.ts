/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { classifyLitellmModel, getLitellmModelCapabilities } from "../litellm-helpers.js";

describe("getLitellmModelCapabilities", () => {
	it("delegates Claude-family ids to the Anthropic table", () => {
		for (const id of [
			"claude-opus-5",
			"anthropic/claude-sonnet-5-20251101",
			"bedrock/us.anthropic.claude-sonnet-4-6-20251001-v1:0",
		]) {
			const caps = getLitellmModelCapabilities(id);
			expect(caps, id).toBeDefined();
			expect(caps?.thinkingEffortLevels, id).toBeDefined();
		}
	});

	it("recognizes provider-prefixed Claude ids without an anthropic segment", () => {
		const caps = getLitellmModelCapabilities("vertex_ai/claude-sonnet-4-6@20251001");
		expect(caps?.family).toBe("claude-4.6");
	});

	it("delegates recognized OpenAI ids to the OpenAI table with the input-token reservation", () => {
		const caps = getLitellmModelCapabilities("openai/gpt-5-mini");
		expect(caps).toBeDefined();
		expect(caps?.thinkingEffortLevels).toContain("high");
		expect(caps?.maxInputTokens).toBe((caps?.maxContextLength ?? 0) - (caps?.maxOutputTokens ?? 0));
	});

	it("returns undefined for unrecognized upstreams", () => {
		expect(getLitellmModelCapabilities("gemini/gemini-2.5-flash")).toBeUndefined();
		expect(getLitellmModelCapabilities("ollama_chat/qwen3-coder:30b")).toBeUndefined();
		expect(getLitellmModelCapabilities("gpt-oss")).toBeUndefined();
	});
});

describe("classifyLitellmModel", () => {
	it("classifies by the underlying model id when present", () => {
		expect(
			classifyLitellmModel({
				alias: "fast-model",
				underlyingModel: "anthropic/claude-haiku-4-5",
				litellmProvider: "anthropic",
			}),
		).toEqual({ family: "claude", capabilityModelId: "anthropic/claude-haiku-4-5" });
		expect(
			classifyLitellmModel({
				alias: "smart-model",
				underlyingModel: "openai/gpt-5-mini",
				litellmProvider: "openai",
			}),
		).toEqual({ family: "openai", capabilityModelId: "openai/gpt-5-mini" });
		expect(
			classifyLitellmModel({
				alias: "flash",
				underlyingModel: "gemini/gemini-2.5-flash",
				litellmProvider: "gemini",
			}),
		).toEqual({ family: "other", capabilityModelId: "gemini/gemini-2.5-flash" });
	});

	it("does not let a deceptive alias override the underlying id", () => {
		// Alias looks like an OpenAI model, upstream is not OpenAI.
		expect(
			classifyLitellmModel({
				alias: "gpt-4o",
				underlyingModel: "gemini/gemini-2.5-flash",
				litellmProvider: "gemini",
			}).family,
		).toBe("other");
		// Alias looks like Claude, upstream is OpenAI.
		expect(
			classifyLitellmModel({
				alias: "claude-fast",
				underlyingModel: "openai/gpt-5-mini",
				litellmProvider: "openai",
			}).family,
		).toBe("openai");
	});

	it("requires an OpenAI provider signal for OpenAI-looking underlying ids", () => {
		// A non-OpenAI provider serving an OpenAI-looking id is not routed as
		// OpenAI (no encrypted-reasoning contract there).
		expect(
			classifyLitellmModel({
				alias: "weird",
				underlyingModel: "some_gateway/gpt-5-mini",
				litellmProvider: "some_gateway",
			}).family,
		).toBe("other");
		// Azure OpenAI serves the same models — accepted.
		expect(
			classifyLitellmModel({
				alias: "azure-gpt",
				underlyingModel: "azure/gpt-5-mini",
				litellmProvider: "azure",
			}).family,
		).toBe("openai");
	});

	it("falls back to the alias only when the entry has no underlying id", () => {
		expect(classifyLitellmModel({ alias: "claude-haiku-4-5" })).toEqual({
			family: "claude",
			capabilityModelId: "claude-haiku-4-5",
		});
		expect(classifyLitellmModel({ alias: "gpt-5-mini", underlyingModel: null })).toEqual({
			family: "openai",
			capabilityModelId: "gpt-5-mini",
		});
		expect(classifyLitellmModel({ alias: "totally-custom", underlyingModel: "" })).toEqual({
			family: "other",
			capabilityModelId: "totally-custom",
		});
	});
});
