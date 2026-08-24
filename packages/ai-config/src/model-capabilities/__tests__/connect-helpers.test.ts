/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { getAnthropicModelCapabilities } from "../anthropic-helpers.js";
import { getConnectBedrockModelCapabilities } from "../connect-helpers.js";

describe("getConnectBedrockModelCapabilities", () => {
	it("borrows limits, family, and media types from the Anthropic-on-Bedrock table", () => {
		const id = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
		const claude = getAnthropicModelCapabilities(id)!;

		const caps = getConnectBedrockModelCapabilities(id);

		expect(caps.family).toBe(claude.family);
		expect(caps.family).toBeDefined();
		expect(caps.maxContextLength).toBe(claude.maxContextLength);
		expect(caps.maxOutputTokens).toBe(claude.maxOutputTokens);
		expect(caps.maxInputTokens).toBe(caps.maxContextLength - caps.maxOutputTokens);
		expect(caps.supportedInputMediaTypes).toEqual(claude.supportedInputMediaTypes);
		expect(caps).toMatchObject({
			supportsTools: true,
			supportsImages: true,
			supportsToolResultImages: true,
			supportsWebSearch: false,
		});
	});

	it("falls back to conservative limits for an id the Anthropic table cannot answer", () => {
		const caps = getConnectBedrockModelCapabilities("mistral.mistral-large-2407-v1:0");

		expect(caps.family).toBeUndefined();
		expect(caps.thinkingEffortLevels).toBeUndefined();
		expect(caps.supportedInputMediaTypes).toBeUndefined();
		expect(caps.maxContextLength).toBe(200_000);
		expect(caps.maxOutputTokens).toBe(4_096);
		expect(caps.maxInputTokens).toBe(caps.maxContextLength - caps.maxOutputTokens);
	});
});
