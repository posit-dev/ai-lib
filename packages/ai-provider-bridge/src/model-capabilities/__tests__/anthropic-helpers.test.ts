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

	describe("claude-fable-5 and claude-mythos-5", () => {
		it("returns family claude-fable-5 with 1M context and 128k output", () => {
			const caps = getAnthropicModelCapabilities("claude-fable-5");
			expect(caps?.family).toBe("claude-fable-5");
			expect(caps?.maxContextLength).toBe(1_000_000);
			expect(caps?.maxOutputTokens).toBe(128_000);
		});

		it("returns family claude-mythos-5 with 1M context and 128k output", () => {
			const caps = getAnthropicModelCapabilities("claude-mythos-5");
			expect(caps?.family).toBe("claude-mythos-5");
			expect(caps?.maxContextLength).toBe(1_000_000);
			expect(caps?.maxOutputTokens).toBe(128_000);
		});

		it("offers adaptive thinking effort levels without 'off' (thinking always on)", () => {
			expect(getAnthropicModelCapabilities("claude-fable-5")?.thinkingEffortLevels).toEqual([
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
			]);
			expect(getAnthropicModelCapabilities("claude-mythos-5")?.thinkingEffortLevels).toEqual([
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
			]);
		});
	});

	describe("claude-sonnet-5", () => {
		it("returns family claude-5 with 1M context and 128k output", () => {
			const caps = getAnthropicModelCapabilities("claude-sonnet-5");
			expect(caps?.family).toBe("claude-5");
			expect(caps?.maxContextLength).toBe(1_000_000);
			expect(caps?.maxOutputTokens).toBe(128_000);
		});

		it("offers the full effort range including 'off' (same profile as Opus 4.8)", () => {
			expect(getAnthropicModelCapabilities("claude-sonnet-5")?.thinkingEffortLevels).toEqual([
				"off",
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
			]);
		});
	});

	describe("Opus 4.6 and 4.7 — 128k output, 1M context", () => {
		for (const id of ["claude-opus-4-6", "claude-opus-4-7"]) {
			it(`returns 128k output and 1M context for ${id}`, () => {
				const caps = getAnthropicModelCapabilities(id);
				expect(caps?.maxOutputTokens).toBe(128_000);
				expect(caps?.maxContextLength).toBe(1_000_000);
			});
		}
	});

	describe("Sonnet 4.6 — 64k output, 1M context", () => {
		it("caps output at 64k with a 1M context (shares the 4.6 version with Opus)", () => {
			const caps = getAnthropicModelCapabilities("claude-sonnet-4-6");
			expect(caps?.maxOutputTokens).toBe(64_000);
			expect(caps?.maxContextLength).toBe(1_000_000);
		});
	});

	describe("Haiku 4.5 — 64k output, 200k context", () => {
		it("caps output at 64k with a 200k context", () => {
			const caps = getAnthropicModelCapabilities("claude-haiku-4-5");
			expect(caps?.maxOutputTokens).toBe(64_000);
			expect(caps?.maxContextLength).toBe(200_000);
		});
	});

	describe("maxInputTokens reserves the output budget", () => {
		it("computes the input ceiling as context minus output", () => {
			const caps = getAnthropicModelCapabilities("claude-opus-4-6");
			expect(caps?.maxInputTokens).toBe(1_000_000 - 128_000);
		});
	});

	describe("unrecognized Claude IDs fall back to a safe 64k default", () => {
		it("returns 64k output for a Claude ID matching no rule", () => {
			// A future/unknown claude-* ID that no rule matches yet.
			expect(getAnthropicModelCapabilities("claude-opus-5")?.maxOutputTokens).toBe(64_000);
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
