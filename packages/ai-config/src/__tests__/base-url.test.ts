/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import {
	normalizeBaseUrlForProvider,
	normalizeFoundryBaseUrl,
	normalizeOpenRouterBaseUrl,
	OPENROUTER_DEFAULT_BASE_URL,
} from "../base-url.js";

describe("normalizeBaseUrlForProvider", () => {
	it("corrects a known bare host after tolerant comparison", () => {
		expect(
			normalizeBaseUrlForProvider("gemini", "  https://generativelanguage.googleapis.com/  "),
		).toBe("https://generativelanguage.googleapis.com/v1beta");
	});

	it("returns non-matching input byte-for-byte", () => {
		for (const url of [
			"https://my-proxy.example/anthropic/",
			"  https://my-proxy.example/anthropic  ",
			"  https://api.anthropic.com/v1  ",
		]) {
			expect(normalizeBaseUrlForProvider("anthropic", url)).toBe(url);
		}
	});

	it("does not apply known-host policy to other providers", () => {
		const url = "https://api.deepseek.com";
		expect(normalizeBaseUrlForProvider("deepseek", url)).toBe(url);
	});

	it("is total for empty input", () => {
		expect(normalizeBaseUrlForProvider("anthropic", "")).toBe("");
	});
});

describe("normalizeFoundryBaseUrl", () => {
	it.each([
		[
			"https://r.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-02-01",
			"https://r.openai.azure.com/openai/v1",
		],
		[
			"https://r.openai.azure.com/openai/deployments/gpt-4o",
			"https://r.openai.azure.com/openai/v1",
		],
		["https://r.openai.azure.com/openai/v1", "https://r.openai.azure.com/openai/v1"],
		["https://r.openai.azure.com/openai/v1/", "https://r.openai.azure.com/openai/v1"],
		[
			"https://r.openai.azure.com/openai/v1/chat/completions",
			"https://r.openai.azure.com/openai/v1",
		],
		[
			"https://r.openai.azure.com/openai/v1/responses?api-version=preview",
			"https://r.openai.azure.com/openai/v1",
		],
		["https://r.openai.azure.com/openai/v10", "https://r.openai.azure.com/openai/v10/openai/v1"],
		["https://r.openai.azure.com/", "https://r.openai.azure.com/openai/v1"],
		["https://r.openai.azure.com", "https://r.openai.azure.com/openai/v1"],
		["https://r.openai.azure.com?api-version=1", "https://r.openai.azure.com/openai/v1"],
		["", ""],
		["   ", ""],
	])("normalizes %s", (input, expected) => {
		expect(normalizeFoundryBaseUrl(input)).toBe(expected);
	});
});

describe("normalizeOpenRouterBaseUrl", () => {
	it("defaults to the canonical API root", () => {
		expect(normalizeOpenRouterBaseUrl()).toBe(OPENROUTER_DEFAULT_BASE_URL);
	});

	it.each([
		["https://openrouter.ai", "https://openrouter.ai/api/v1"],
		[" https://gateway.example.com/ ", "https://gateway.example.com/api/v1"],
		["https://gateway.example.com/api/v1/", "https://gateway.example.com/api/v1"],
	])("normalizes %s", (input, expected) => {
		expect(normalizeOpenRouterBaseUrl(input)).toBe(expected);
	});
});
