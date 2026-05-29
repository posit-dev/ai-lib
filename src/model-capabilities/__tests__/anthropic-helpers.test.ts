/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { getAnthropicModelCapabilities } from "../anthropic-helpers";

describe("getAnthropicModelCapabilities", () => {
	describe("claude-opus-4-8", () => {
		it("returns family claude-4.8", () => {
			expect(getAnthropicModelCapabilities("claude-opus-4-8")?.family).toBe("claude-4.8");
		});

		it("returns thinking effort levels", () => {
			expect(getAnthropicModelCapabilities("claude-opus-4-8")?.thinkingEffortLevels).toEqual([
				"off",
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
			]);
		});

		it("returns maxOutputTokens 128000", () => {
			expect(getAnthropicModelCapabilities("claude-opus-4-8")?.maxOutputTokens).toBe(128_000);
		});

		it("returns maxContextLength 1_000_000", () => {
			expect(getAnthropicModelCapabilities("claude-opus-4-8")?.maxContextLength).toBe(1_000_000);
		});
	});

	describe("claude-opus-4-7 regression — maxContextLength stays 200_000", () => {
		it("returns maxContextLength 200_000 for 4.7", () => {
			expect(getAnthropicModelCapabilities("claude-opus-4-7")?.maxContextLength).toBe(200_000);
		});

		it("returns maxContextLength 200_000 for 4.6", () => {
			expect(getAnthropicModelCapabilities("claude-opus-4-6")?.maxContextLength).toBe(200_000);
		});
	});

	describe("provider-prefixed IDs", () => {
		it("handles Bedrock direct format", () => {
			const caps = getAnthropicModelCapabilities("anthropic.claude-opus-4-8-v1:0");
			expect(caps?.family).toBe("claude-4.8");
			expect(caps?.maxContextLength).toBe(1_000_000);
		});

		it("handles Bedrock inference profile format", () => {
			const caps = getAnthropicModelCapabilities("us.anthropic.claude-opus-4-8-v1:0");
			expect(caps?.family).toBe("claude-4.8");
		});
	});

	describe("non-Claude models return undefined", () => {
		it("returns undefined for non-Claude model", () => {
			expect(getAnthropicModelCapabilities("gpt-4o")).toBeUndefined();
		});
	});
});
