/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import type { Protocol } from "../../vocabulary.js";
import { getBedrockMantleModelCapabilities } from "../bedrock-mantle-helpers.js";

type SupportedFamilyCase = {
	name: string;
	id: string;
	expectedProtocol: Protocol;
};

const SUPPORTED_FAMILY_CASES = [
	{ name: "GPT OSS", id: "openai.gpt-oss-120b", expectedProtocol: "openai-chat" },
	{ name: "GPT 5.x", id: "openai.gpt-5.6-terra", expectedProtocol: "openai-responses" },
] satisfies readonly SupportedFamilyCase[];

describe("Bedrock Mantle capability rules", () => {
	it.each(SUPPORTED_FAMILY_CASES)("classifies the $name family", ({ id, expectedProtocol }) => {
		expect(getBedrockMantleModelCapabilities(id)?.protocol).toBe(expectedProtocol);
	});

	it("does not treat the misleading GPT OSS prefix on a safeguard id as a chat model", () => {
		expect(getBedrockMantleModelCapabilities("openai.gpt-oss-safeguard-120b")).toBeUndefined();
	});

	it("returns undefined for an unknown Bedrock Mantle model", () => {
		expect(getBedrockMantleModelCapabilities("openai.future-model")).toBeUndefined();
	});

	it("does not invent a GPT-5.x output ceiling", () => {
		const gpt5 = getBedrockMantleModelCapabilities("openai.gpt-5.5");
		expect(gpt5?.maxOutputTokens).toBeUndefined();
	});
});
