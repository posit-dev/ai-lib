/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { getAnthropicModelCapabilities } from "../anthropic-helpers.js";

type OutputPrecedenceCase = {
	name: string;
	id: string;
	expectedMaxOutputTokens: number;
};

const OUTPUT_PRECEDENCE_CASES = [
	{ name: "Opus 4.6", id: "claude-opus-4-6", expectedMaxOutputTokens: 128_000 },
	{ name: "Sonnet 4.6", id: "claude-sonnet-4-6", expectedMaxOutputTokens: 64_000 },
] satisfies readonly OutputPrecedenceCase[];

type ProviderPrefixCase = {
	name: string;
	id: string;
};

const PROVIDER_PREFIX_CASES = [
	{ name: "Bedrock provider prefix", id: "anthropic.claude-opus-4-8-v1:0" },
	{ name: "regional Bedrock provider prefix", id: "us.anthropic.claude-opus-4-8-v1:0" },
	{ name: "slash provider prefix", id: "anthropic/claude-opus-4.8" },
] satisfies readonly ProviderPrefixCase[];

describe("getAnthropicModelCapabilities", () => {
	it.each(OUTPUT_PRECEDENCE_CASES)(
		"applies the $name tier-specific rule before broader generation rules",
		({ id, expectedMaxOutputTokens }) => {
			expect(getAnthropicModelCapabilities(id)?.maxOutputTokens).toBe(expectedMaxOutputTokens);
		},
	);

	it.each(PROVIDER_PREFIX_CASES)("normalizes a $name", ({ id }) => {
		expect(getAnthropicModelCapabilities(id)?.family).toBe("claude-4.8");
	});

	it("reserves the output budget inside the context window", () => {
		const caps = getAnthropicModelCapabilities("claude-opus-4-6");
		expect(caps?.maxInputTokens).toBe((caps?.maxContextLength ?? 0) - (caps?.maxOutputTokens ?? 0));
	});

	it("uses a conservative fallback for an unrecognized Claude model", () => {
		expect(getAnthropicModelCapabilities("claude-opus-6")?.maxOutputTokens).toBe(64_000);
	});

	it("returns undefined for non-Claude models", () => {
		expect(getAnthropicModelCapabilities("gpt-4o")).toBeUndefined();
	});
});
