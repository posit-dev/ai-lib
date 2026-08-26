/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import {
	buildSnowflakeCortexUrl,
	buildSnowflakeCortexUrlFromHost,
	normalizeProviderBaseUrl,
	positAiThinkingRequestFields,
	thinkingRequestFields,
} from "../utils";

describe("thinkingRequestFields", () => {
	it("returns undefined when thinking is off or unset", () => {
		expect(thinkingRequestFields(undefined, true)).toBeUndefined();
		expect(thinkingRequestFields("off", true)).toBeUndefined();
	});

	it("maps a named effort level to a top-level reasoning_effort", () => {
		expect(thinkingRequestFields("low", false)).toEqual({ reasoning_effort: "low" });
		expect(thinkingRequestFields("max", false)).toEqual({ reasoning_effort: "max" });
	});

	it("maps binary 'on' to chat_template_kwargs when the model requires it", () => {
		expect(thinkingRequestFields("on", true)).toEqual({
			chat_template_kwargs: { enable_thinking: true },
		});
	});

	it("returns undefined for binary 'on' without the chat_template_kwargs flag", () => {
		expect(thinkingRequestFields("on", false)).toBeUndefined();
	});
});

describe("positAiThinkingRequestFields", () => {
	it("maps DeepSeek off to none and reuses named efforts", () => {
		expect(
			positAiThinkingRequestFields("deepseek-ai/DeepSeek-V4-Flash-0731", "off", false),
		).toEqual({
			reasoning_effort: "none",
		});
		expect(
			positAiThinkingRequestFields("deepseek-ai/DeepSeek-V4-Flash-0731", "high", false),
		).toEqual({ reasoning_effort: "high" });
	});
});

describe("normalizeProviderBaseUrl", () => {
	const HOST = "https://api.anthropic.com";

	it("returns the versioned default when baseUrl is undefined", () => {
		expect(normalizeProviderBaseUrl(undefined, HOST, "v1")).toBe("https://api.anthropic.com/v1");
	});

	it("returns the versioned default when baseUrl is empty", () => {
		expect(normalizeProviderBaseUrl("", HOST, "v1")).toBe("https://api.anthropic.com/v1");
	});

	it("returns the versioned default when baseUrl is whitespace only", () => {
		expect(normalizeProviderBaseUrl("   ", HOST, "v1")).toBe("https://api.anthropic.com/v1");
	});

	it("trims surrounding whitespace from a custom host", () => {
		expect(normalizeProviderBaseUrl("  https://my-proxy.example/anthropic  ", HOST, "v1")).toBe(
			"https://my-proxy.example/anthropic",
		);
	});

	it("does not append the version segment to a bare host with no version path", () => {
		expect(normalizeProviderBaseUrl("https://api.anthropic.com", HOST, "v1")).toBe(
			"https://api.anthropic.com",
		);
	});

	it("trims a trailing slash on a bare host without appending the version segment", () => {
		expect(normalizeProviderBaseUrl("https://api.anthropic.com/", HOST, "v1")).toBe(
			"https://api.anthropic.com",
		);
	});

	it("leaves a host that already includes the version segment untouched", () => {
		expect(normalizeProviderBaseUrl("https://api.anthropic.com/v1", HOST, "v1")).toBe(
			"https://api.anthropic.com/v1",
		);
	});

	it("strips a trailing slash but keeps an existing version segment", () => {
		expect(normalizeProviderBaseUrl("https://api.anthropic.com/v1/", HOST, "v1")).toBe(
			"https://api.anthropic.com/v1",
		);
	});

	it("leaves a custom proxy/gateway untouched", () => {
		expect(normalizeProviderBaseUrl("https://my-proxy.example/anthropic", HOST, "v1")).toBe(
			"https://my-proxy.example/anthropic",
		);
	});

	it("supports non-v1 version segments (Gemini) when unset", () => {
		const geminiHost = "https://generativelanguage.googleapis.com";
		expect(normalizeProviderBaseUrl(undefined, geminiHost, "v1beta")).toBe(
			"https://generativelanguage.googleapis.com/v1beta",
		);
	});

	it("leaves a bare configured Gemini host bare (no version segment appended)", () => {
		const geminiHost = "https://generativelanguage.googleapis.com";
		expect(normalizeProviderBaseUrl(geminiHost, geminiHost, "v1beta")).toBe(geminiHost);
	});
});

describe("buildSnowflakeCortexUrl", () => {
	it("builds the Cortex URL from a full hostname", () => {
		expect(buildSnowflakeCortexUrlFromHost("pl.example.privatelink.snowflakecomputing.com")).toBe(
			"https://pl.example.privatelink.snowflakecomputing.com/api/v2/cortex/v1",
		);
	});

	it("builds the Cortex URL from an account identifier", () => {
		expect(buildSnowflakeCortexUrl("myorg-myaccount")).toBe(
			"https://myorg-myaccount.snowflakecomputing.com/api/v2/cortex/v1",
		);
	});
});
