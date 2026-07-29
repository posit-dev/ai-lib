/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { getBedrockMantleModelCapabilities } from "../bedrock-mantle-helpers.js";

describe("Bedrock Mantle capability rules", () => {
	it("classifies supported families and deliberately excludes non-chat ids", () => {
		expect(getBedrockMantleModelCapabilities("openai.gpt-oss-120b")?.protocol).toBe("openai-chat");
		expect(getBedrockMantleModelCapabilities("openai.gpt-5.6-terra")?.protocol).toBe(
			"openai-responses",
		);
		expect(getBedrockMantleModelCapabilities("openai.gpt-oss-safeguard-120b")).toBeUndefined();
		expect(getBedrockMantleModelCapabilities("openai.future-model")).toBeUndefined();
	});

	it("does not invent a GPT-5.x output ceiling", () => {
		const gpt5 = getBedrockMantleModelCapabilities("openai.gpt-5.5");
		expect(gpt5?.maxOutputTokens).toBeUndefined();
		expect(gpt5?.thinkingEffortLevels).toEqual(["off", "low", "medium", "high", "xhigh"]);
		expect(getBedrockMantleModelCapabilities("openai.gpt-oss-120b")?.thinkingEffortLevels).toEqual([
			"low",
			"medium",
			"high",
		]);
	});
});
