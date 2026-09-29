/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Mechanism tests for OpenCode protocol routing: product classification from
 * the resolved URL, family-prefix boundaries, the product-dependent MiniMax
 * split, and the fallbacks. These pin the MECHANISMS — they deliberately do
 * not restate every row of the documented endpoint tables (see
 * opencode-routing.ts for sources and review dates).
 */

import { describe, expect, it } from "vitest";

import { OPENCODE_GO_BASE_URL, OPENCODE_ZEN_BASE_URL } from "../../base-url.js";
import { inferOpencodeProtocol, opencodeProductForBaseUrl } from "../opencode-routing.js";

describe("opencodeProductForBaseUrl", () => {
	it("classifies the canonical roots, tolerating trailing slashes and whitespace", () => {
		expect(opencodeProductForBaseUrl(OPENCODE_GO_BASE_URL)).toBe("go");
		expect(opencodeProductForBaseUrl(`${OPENCODE_GO_BASE_URL}/`)).toBe("go");
		expect(opencodeProductForBaseUrl(` ${OPENCODE_ZEN_BASE_URL}// `)).toBe("zen");
	});

	it("treats an absent URL as the built-in default product (go)", () => {
		expect(opencodeProductForBaseUrl(undefined)).toBe("go");
		expect(opencodeProductForBaseUrl("  ")).toBe("go");
	});

	it("does not classify an unrecognized proxy URL as either product", () => {
		expect(opencodeProductForBaseUrl("https://gateway.example.com/v1")).toBeUndefined();
		// Lookalike paths on the right host but not the canonical roots.
		expect(opencodeProductForBaseUrl("https://opencode.ai/zen/go/v2")).toBeUndefined();
	});
});

describe("inferOpencodeProtocol", () => {
	it("routes Responses families on both products", () => {
		expect(inferOpencodeProtocol("gpt-5.6-luna", OPENCODE_GO_BASE_URL)).toBe("openai-responses");
		expect(inferOpencodeProtocol("gpt-5.6-luna", OPENCODE_ZEN_BASE_URL)).toBe("openai-responses");
		expect(inferOpencodeProtocol("grok-4.6", OPENCODE_ZEN_BASE_URL)).toBe("openai-responses");
	});

	it("splits MiniMax by product: Messages on Go, Chat Completions on Zen", () => {
		expect(inferOpencodeProtocol("minimax-m3", OPENCODE_GO_BASE_URL)).toBe("anthropic-messages");
		expect(inferOpencodeProtocol("minimax-m3", OPENCODE_ZEN_BASE_URL)).toBe("openai-chat");
	});

	it("routes Zen-only families natively on Zen and to the fallback on Go", () => {
		expect(inferOpencodeProtocol("claude-opus-5", OPENCODE_ZEN_BASE_URL)).toBe(
			"anthropic-messages",
		);
		expect(inferOpencodeProtocol("claude-opus-5", OPENCODE_GO_BASE_URL)).toBe("openai-chat");
		expect(inferOpencodeProtocol("gemini-3.8-flash", OPENCODE_ZEN_BASE_URL)).toBe(
			"google-generative",
		);
		expect(inferOpencodeProtocol("gemini-3.8-flash", OPENCODE_GO_BASE_URL)).toBe("openai-chat");
	});

	it("matches qwen without requiring a hyphen boundary", () => {
		expect(inferOpencodeProtocol("qwen3.7-max", OPENCODE_ZEN_BASE_URL)).toBe("anthropic-messages");
	});

	it("respects prefix boundaries instead of substring matching", () => {
		expect(inferOpencodeProtocol("mygpt-1", OPENCODE_ZEN_BASE_URL)).toBe("openai-chat");
		expect(inferOpencodeProtocol("notqwen-1", OPENCODE_ZEN_BASE_URL)).toBe("openai-chat");
		expect(inferOpencodeProtocol("minimaxer-1", OPENCODE_ZEN_BASE_URL)).toBe("openai-chat");
	});

	it("matches catalog ids case-insensitively without rewriting them", () => {
		expect(inferOpencodeProtocol("GPT-5.6-LUNA", OPENCODE_ZEN_BASE_URL)).toBe("openai-responses");
		expect(inferOpencodeProtocol("MiniMax-M3", OPENCODE_GO_BASE_URL)).toBe("anthropic-messages");
	});

	it("falls back to Chat Completions for unknown models and unrecognized URLs", () => {
		expect(inferOpencodeProtocol("some-future-model", OPENCODE_ZEN_BASE_URL)).toBe("openai-chat");
		// A proxy URL carries no product context: the conservative fallback
		// applies even to ids that would route natively on a known product.
		expect(inferOpencodeProtocol("claude-opus-5", "https://gateway.example.com/v1")).toBe(
			"openai-chat",
		);
	});

	it("uses Go routing when the URL is absent (the built-in default)", () => {
		expect(inferOpencodeProtocol("minimax-m3")).toBe("anthropic-messages");
		expect(inferOpencodeProtocol("claude-opus-5")).toBe("openai-chat");
	});
});
