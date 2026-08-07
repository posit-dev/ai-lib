/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { getLitellmModelCapabilities } from "../litellm-helpers.js";

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

	it("returns undefined for non-Claude upstreams", () => {
		expect(getLitellmModelCapabilities("openai/gpt-5-mini")).toBeUndefined();
		expect(getLitellmModelCapabilities("gemini/gemini-2.5-flash")).toBeUndefined();
		expect(getLitellmModelCapabilities("ollama_chat/qwen3-coder:30b")).toBeUndefined();
		expect(getLitellmModelCapabilities("gpt-oss")).toBeUndefined();
	});
});
