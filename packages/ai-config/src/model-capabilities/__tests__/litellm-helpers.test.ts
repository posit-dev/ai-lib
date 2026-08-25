/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import {
	classifyLitellmModel,
	getLitellmModelCapabilities,
	type LitellmModelClassification,
	type LitellmModelClassificationInput,
} from "../litellm-helpers.js";

type ModelIdCase = {
	name: string;
	id: string;
};

const CLAUDE_DELEGATION_CASES = [
	{ name: "bare future Claude id", id: "claude-opus-5" },
	{ name: "Anthropic-prefixed Claude id", id: "anthropic/claude-sonnet-5-20251101" },
	{
		name: "Bedrock-prefixed Claude id",
		id: "bedrock/us.anthropic.claude-sonnet-4-6-20251001-v1:0",
	},
] satisfies readonly ModelIdCase[];

const UNRECOGNIZED_UPSTREAM_CASES = [
	{ name: "Gemini upstream", id: "gemini/gemini-2.5-flash" },
	{ name: "Ollama upstream", id: "ollama_chat/qwen3-coder:30b" },
	{ name: "unqualified GPT OSS id", id: "gpt-oss" },
] satisfies readonly ModelIdCase[];

const FUTURE_OPENAI_CASES = [
	{ name: "future GPT id", id: "openai/gpt-6-mini" },
	{ name: "o3 id", id: "openai/o3" },
	{ name: "o4 Mini id", id: "openai/o4-mini" },
] satisfies readonly ModelIdCase[];

type UnderlyingClassificationCase = {
	name: string;
	input: LitellmModelClassificationInput;
	expected: LitellmModelClassification;
};

const UNDERLYING_CLASSIFICATION_CASES = [
	{
		name: "Claude underlying id",
		input: {
			alias: "fast-model",
			underlyingModel: "anthropic/claude-haiku-4-5",
			litellmProvider: "anthropic",
		},
		expected: { family: "claude", capabilityModelId: "anthropic/claude-haiku-4-5" },
	},
	{
		name: "OpenAI underlying id",
		input: {
			alias: "smart-model",
			underlyingModel: "openai/gpt-5-mini",
			litellmProvider: "openai",
		},
		expected: { family: "openai", capabilityModelId: "openai/gpt-5-mini" },
	},
	{
		name: "other underlying id",
		input: {
			alias: "flash",
			underlyingModel: "gemini/gemini-2.5-flash",
			litellmProvider: "gemini",
		},
		expected: { family: "other", capabilityModelId: "gemini/gemini-2.5-flash" },
	},
] satisfies readonly UnderlyingClassificationCase[];

type AliasFallbackCase = {
	name: string;
	input: LitellmModelClassificationInput;
	expected: LitellmModelClassification;
};

const ALIAS_FALLBACK_CASES = [
	{
		name: "an omitted underlying id",
		input: { alias: "claude-haiku-4-5" },
		expected: { family: "claude", capabilityModelId: "claude-haiku-4-5" },
	},
	{
		name: "a null underlying id",
		input: { alias: "gpt-5-mini", underlyingModel: null },
		expected: { family: "openai", capabilityModelId: "gpt-5-mini" },
	},
	{
		name: "an empty underlying id",
		input: { alias: "totally-custom", underlyingModel: "" },
		expected: { family: "other", capabilityModelId: "totally-custom" },
	},
] satisfies readonly AliasFallbackCase[];

describe("getLitellmModelCapabilities", () => {
	it.each(CLAUDE_DELEGATION_CASES)("delegates a $name to the Anthropic table", ({ id }) => {
		const caps = getLitellmModelCapabilities(id);
		expect(caps).toBeDefined();
		expect(caps?.thinkingEffortLevels).toBeDefined();
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

	it.each(UNRECOGNIZED_UPSTREAM_CASES)("returns undefined for a $name", ({ id }) => {
		expect(getLitellmModelCapabilities(id)).toBeUndefined();
	});
});

describe("classifyLitellmModel", () => {
	it.each(UNDERLYING_CLASSIFICATION_CASES)(
		"classifies by the $name when present",
		({ input, expected }) => {
			expect(classifyLitellmModel(input)).toEqual(expected);
		},
	);

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

	it.each(FUTURE_OPENAI_CASES)(
		"recognizes a $name independently of the capability table",
		({ id }) => {
			expect(
				classifyLitellmModel({
					alias: "future-model",
					underlyingModel: id,
					litellmProvider: "openai",
				}).family,
			).toBe("openai");
		},
	);

	it.each(ALIAS_FALLBACK_CASES)("falls back to the alias for $name", ({ input, expected }) => {
		expect(classifyLitellmModel(input)).toEqual(expected);
	});

	it("lets provider metadata veto an OpenAI-looking alias when the underlying id is absent", () => {
		expect(
			classifyLitellmModel({
				alias: "gpt-5-mini",
				litellmProvider: "gemini",
			}),
		).toEqual({ family: "other", capabilityModelId: "gpt-5-mini" });
	});
});
