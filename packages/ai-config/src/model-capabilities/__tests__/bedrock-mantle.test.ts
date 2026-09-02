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
		for (const id of ["openai.gpt-5.4", "openai.gpt-5.5", "openai.gpt-5.7"]) {
			const gpt5 = getBedrockMantleModelCapabilities(id);
			expect(gpt5?.maxContextLength).toBe(272_000);
			expect(gpt5?.maxOutputTokens).toBeUndefined();
		}
	});

	it("applies the documented 1M window only to GPT-5.6 production variants", () => {
		for (const id of [
			"openai.gpt-5.6",
			"openai.gpt-5.6-sol",
			"openai.gpt-5.6-terra",
			"openai.gpt-5.6-luna",
			"openai.gpt-5.6-sol-2026-07-13",
		]) {
			const capabilities = getBedrockMantleModelCapabilities(id);
			expect(capabilities?.maxContextLength).toBe(1_000_000);
			expect(capabilities?.maxInputTokens).toBeUndefined();
			expect(capabilities?.maxOutputTokens).toBeUndefined();
		}
	});
});
