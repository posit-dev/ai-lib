/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { getAnthropicModelCapabilities } from "../anthropic-helpers.js";

describe("getAnthropicModelCapabilities", () => {
	it("applies tier-specific rules before broader generation rules", () => {
		expect(getAnthropicModelCapabilities("claude-opus-4-6")?.maxOutputTokens).toBe(128_000);
		expect(getAnthropicModelCapabilities("claude-sonnet-4-6")?.maxOutputTokens).toBe(64_000);
	});

	it("normalizes provider-prefixed Claude IDs", () => {
		for (const id of [
			"anthropic.claude-opus-4-8-v1:0",
			"us.anthropic.claude-opus-4-8-v1:0",
			"anthropic/claude-opus-4.8",
		]) {
			expect(getAnthropicModelCapabilities(id)?.family, id).toBe("claude-4.8");
		}
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
