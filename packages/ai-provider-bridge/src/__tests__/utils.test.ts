/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import {
	buildSnowflakeCortexUrl,
	buildSnowflakeCortexUrlFromHost,
	normalizeConfiguredBaseUrl,
	normalizeProviderBaseUrl,
} from "../utils";

describe("normalizeConfiguredBaseUrl", () => {
	const HOST = "https://api.anthropic.com";

	it("returns undefined when baseUrl is undefined", () => {
		expect(normalizeConfiguredBaseUrl(undefined, HOST, "v1")).toBeUndefined();
	});

	it("returns undefined when baseUrl is empty", () => {
		expect(normalizeConfiguredBaseUrl("", HOST, "v1")).toBeUndefined();
	});

	it("returns undefined when baseUrl is whitespace only", () => {
		expect(normalizeConfiguredBaseUrl("   ", HOST, "v1")).toBeUndefined();
	});

	it("appends the version segment when given the host with no version path", () => {
		expect(normalizeConfiguredBaseUrl("https://api.anthropic.com", HOST, "v1")).toBe(
			"https://api.anthropic.com/v1",
		);
	});

	it("normalizes a trailing slash on a host with no version path", () => {
		expect(normalizeConfiguredBaseUrl("https://api.anthropic.com/", HOST, "v1")).toBe(
			"https://api.anthropic.com/v1",
		);
	});

	it("leaves a host that already includes the version segment untouched", () => {
		expect(normalizeConfiguredBaseUrl("https://api.anthropic.com/v1", HOST, "v1")).toBe(
			"https://api.anthropic.com/v1",
		);
	});

	it("trims surrounding whitespace and a trailing slash from a custom host", () => {
		expect(normalizeConfiguredBaseUrl("  https://my-proxy.example/anthropic/  ", HOST, "v1")).toBe(
			"https://my-proxy.example/anthropic",
		);
	});

	it("leaves a custom proxy/gateway untouched", () => {
		expect(normalizeConfiguredBaseUrl("https://my-proxy.example/anthropic", HOST, "v1")).toBe(
			"https://my-proxy.example/anthropic",
		);
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

	it("appends the version segment when given the host with no version path", () => {
		expect(normalizeProviderBaseUrl("https://api.anthropic.com", HOST, "v1")).toBe(
			"https://api.anthropic.com/v1",
		);
	});

	it("normalizes a trailing slash on a host with no version path", () => {
		expect(normalizeProviderBaseUrl("https://api.anthropic.com/", HOST, "v1")).toBe(
			"https://api.anthropic.com/v1",
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

	it("supports non-v1 version segments (Gemini)", () => {
		const geminiHost = "https://generativelanguage.googleapis.com";
		expect(normalizeProviderBaseUrl(geminiHost, geminiHost, "v1beta")).toBe(
			"https://generativelanguage.googleapis.com/v1beta",
		);
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
