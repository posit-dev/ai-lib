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
		"keeps the $name tier-specific output limit within a shared generation",
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

	it("matches claude-fable-5-1 to the Fable tier with always-on adaptive thinking", () => {
		const caps = getAnthropicModelCapabilities("claude-fable-5-1");
		expect(caps?.family).toBe("claude-fable-5");
		expect(caps?.maxContextLength).toBe(1_000_000);
		expect(caps?.maxOutputTokens).toBe(128_000);
		expect(caps?.thinkingEffortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});

	it.each([
		{ name: "bare ID", id: "claude-opus-5-5" },
		{ name: "Bedrock-prefixed ID", id: "anthropic.claude-opus-5-5" },
	])("matches $name to the Opus 5.5 rule with always-on adaptive thinking", ({ id }) => {
		const caps = getAnthropicModelCapabilities(id);
		expect(caps?.family).toBe("claude-5.5");
		expect(caps?.maxContextLength).toBe(1_000_000);
		expect(caps?.maxOutputTokens).toBe(128_000);
		expect(caps?.thinkingEffortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});

	it.each([
		{ name: "bare ID", id: "claude-sonnet-5-5" },
		{ name: "Bedrock-prefixed ID", id: "anthropic.claude-sonnet-5-5" },
		{ name: "dot-separated ID", id: "anthropic/claude-sonnet-5.5" },
	])("matches $name to the Sonnet 5.5 rule without an off level", ({ id }) => {
		const caps = getAnthropicModelCapabilities(id);
		expect(caps?.family).toBe("claude-5.5");
		expect(caps?.maxContextLength).toBe(1_000_000);
		expect(caps?.maxOutputTokens).toBe(128_000);
		expect(caps?.thinkingEffortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});

	it.each([
		{ name: "bare ID", id: "claude-haiku-5-5" },
		{ name: "Bedrock-prefixed ID", id: "anthropic.claude-haiku-5-5" },
		{ name: "regional Bedrock ID", id: "us.anthropic.claude-haiku-5-5" },
		{ name: "dot-separated ID", id: "anthropic/claude-haiku-5.5" },
	])("matches $name to the Haiku 5.5 rule with an off level", ({ id }) => {
		const caps = getAnthropicModelCapabilities(id);
		expect(caps?.family).toBe("claude-5.5");
		expect(caps?.maxContextLength).toBe(1_000_000);
		expect(caps?.maxOutputTokens).toBe(128_000);
		expect(caps?.thinkingEffortLevels).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
	});

	it("still matches claude-haiku-4-5 to the Haiku 4.5 rule", () => {
		const caps = getAnthropicModelCapabilities("claude-haiku-4-5-20251001");
		expect(caps?.maxContextLength).toBe(200_000);
		expect(caps?.thinkingEffortLevels).toBeUndefined();
	});

	it("still matches plain claude-sonnet-5 to the generic Sonnet 5 rule", () => {
		const caps = getAnthropicModelCapabilities("claude-sonnet-5");
		expect(caps?.family).toBe("claude-5");
		expect(caps?.thinkingEffortLevels).toContain("off");
	});

	it("still matches plain claude-opus-5 to the generic Opus 5 rule", () => {
		const caps = getAnthropicModelCapabilities("claude-opus-5");
		expect(caps?.family).toBe("claude-5");
		expect(caps?.thinkingEffortLevels).toContain("off");
	});

	it.each([
		// Regression: the broad `^claude-sonnet-5` rule used to answer with Sonnet 5's "off".
		{ name: "a later minor version", id: "claude-sonnet-5-7", donor: "claude-sonnet-5-5" },
		{ name: "a major bump", id: "claude-opus-6", donor: "claude-opus-5-5" },
		{ name: "a minor below the next major", id: "claude-sonnet-4-7", donor: "claude-sonnet-4-6" },
		{ name: "a two-digit minor", id: "claude-opus-4-10", donor: "claude-opus-4-8" },
	])("inherits the nearest older same-tier entry for $name", ({ id, donor }) => {
		expect(getAnthropicModelCapabilities(id)).toEqual(getAnthropicModelCapabilities(donor));
	});

	it.each([
		{ name: "a dated suffix", id: "claude-sonnet-5-20260724", canonical: "claude-sonnet-5" },
		{ name: "a Vertex suffix", id: "claude-opus-4-8@20260101", canonical: "claude-opus-4-8" },
	])("matches $name exactly, never reading a date as a minor", ({ id, canonical }) => {
		expect(getAnthropicModelCapabilities(id)).toEqual(getAnthropicModelCapabilities(canonical));
	});

	it.each([
		{
			name: "below the first tier entry",
			id: "claude-sonnet-4-5",
			family: "claude-4.5",
			out: 16_000,
		},
		{ name: "a pre-tier shape", id: "claude-3-5-sonnet-20241022", family: "claude-3", out: 8_192 },
	])("keeps the legacy result for an id $name", ({ id, family, out }) => {
		const caps = getAnthropicModelCapabilities(id);
		expect(caps?.family).toBe(family);
		expect(caps?.maxOutputTokens).toBe(out);
	});

	it("uses a conservative fallback for an unknown Claude tier", () => {
		const caps = getAnthropicModelCapabilities("claude-poet-6");
		expect(caps?.family).toBeUndefined();
		expect(caps?.maxContextLength).toBe(200_000);
		expect(caps?.maxOutputTokens).toBe(64_000);
	});

	it("returns undefined for non-Claude models", () => {
		expect(getAnthropicModelCapabilities("gpt-4o")).toBeUndefined();
	});
});
