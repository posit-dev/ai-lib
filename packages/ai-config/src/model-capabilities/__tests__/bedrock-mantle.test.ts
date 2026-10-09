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
	{ name: "GPT 6", id: "openai.gpt-6-astra", expectedProtocol: "openai-responses" },
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

	it("marks only the documented GPT-5.4/5.5/5.6 families as web-search capable", () => {
		for (const id of ["openai.gpt-5.4", "openai.gpt-5.5", "openai.gpt-5.6-sol", "openai.gpt-5.6"]) {
			expect(getBedrockMantleModelCapabilities(id)?.supportsWebSearch).toBe(true);
		}
		// gpt-oss and unknown/future families stay search-incapable; a newly
		// supported family requires a deliberate table update.
		for (const id of ["openai.gpt-oss-120b", "openai.gpt-5.9", "openai.gpt-5.6-unknown"]) {
			expect(getBedrockMantleModelCapabilities(id)?.supportsWebSearch).toBe(false);
		}
	});

	it("pins known older GPT-5.x releases at 272K without inventing an output ceiling", () => {
		for (const id of ["openai.gpt-5.4", "openai.gpt-5.5"]) {
			const gpt5 = getBedrockMantleModelCapabilities(id);
			expect(gpt5?.maxContextLength).toBe(272_000);
			expect(gpt5?.maxOutputTokens).toBeUndefined();
		}
	});

	it("defaults unknown future GPT-5.x IDs to the 1M family window", () => {
		const gpt5 = getBedrockMantleModelCapabilities("openai.gpt-5.7");
		expect(gpt5?.maxContextLength).toBe(1_000_000);
		expect(gpt5?.maxOutputTokens).toBeUndefined();
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

	it("applies the documented GPT-6 Astra window and output ceiling", () => {
		for (const id of ["openai.gpt-6-astra", "openai.gpt-6-astra-2026-09-08"]) {
			const capabilities = getBedrockMantleModelCapabilities(id);
			expect(capabilities?.maxContextLength).toBe(1_050_000);
			expect(capabilities?.maxOutputTokens).toBe(128_000);
			// Astra has no "none" effort level; Mantle maps "off" to "none".
			expect(capabilities?.thinkingEffortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
		}
	});

	it("defaults unknown future GPT-6 IDs to the 1M family window", () => {
		const capabilities = getBedrockMantleModelCapabilities("openai.gpt-6.1");
		expect(capabilities?.maxContextLength).toBe(1_000_000);
		expect(capabilities?.maxOutputTokens).toBeUndefined();
	});

	it.each(["openai.gpt-6.1-sol", "openai.gpt-6.1-sol-2026-09-29"])(
		"omits the unsupported off level for GPT-6.1 Sol id %s",
		(id) => {
			const capabilities = getBedrockMantleModelCapabilities(id);
			expect(capabilities?.protocol).toBe("openai-responses");
			expect(capabilities?.thinkingEffortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
			// Reasoning is shared with OpenAI; capacity stays Bedrock's own.
			expect(capabilities?.maxContextLength).toBe(1_000_000);
			expect(capabilities?.maxOutputTokens).toBeUndefined();
		},
	);

	it.each(["openai.gpt-6-sol", "openai.gpt-6-luna", "openai.gpt-6.2"])(
		"keeps the off level for %s",
		(id) => {
			expect(getBedrockMantleModelCapabilities(id)?.thinkingEffortLevels).toEqual([
				"off",
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
			]);
		},
	);

	it("applies Astra's reasoning rule without its dated-ID capacity rule to other suffixes", () => {
		const capabilities = getBedrockMantleModelCapabilities("openai.gpt-6-astra-preview");
		expect(capabilities?.thinkingEffortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(capabilities?.maxContextLength).toBe(1_000_000);
		expect(capabilities?.maxOutputTokens).toBeUndefined();
	});

	it("matches the no-off models only at a model-name boundary", () => {
		for (const id of ["openai.gpt-6-astral", "openai.gpt-6.1-solar"]) {
			expect(getBedrockMantleModelCapabilities(id)?.thinkingEffortLevels).toContain("off");
		}
	});

	it.each([
		"openai.gpt-5.6-unknown",
		"openai.gpt-5.6-unknown-2026-07-13",
		"openai.gpt-5.6-sol-preview",
	])("applies the 1M family default to unverified GPT-5.6 id %s", (id) => {
		const capabilities = getBedrockMantleModelCapabilities(id);
		expect(capabilities?.maxContextLength).toBe(1_000_000);
		expect(capabilities?.maxInputTokens).toBeUndefined();
		expect(capabilities?.maxOutputTokens).toBeUndefined();
	});
});
