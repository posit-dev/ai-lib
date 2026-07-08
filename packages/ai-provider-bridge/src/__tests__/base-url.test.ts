/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { normalizeBaseUrlForProvider } from "../base-url";

interface KnownProviderCase {
	providerId: "anthropic" | "openai" | "gemini";
	host: string;
	versioned: string;
}

const KNOWN_PROVIDERS: KnownProviderCase[] = [
	{
		providerId: "anthropic",
		host: "https://api.anthropic.com",
		versioned: "https://api.anthropic.com/v1",
	},
	{ providerId: "openai", host: "https://api.openai.com", versioned: "https://api.openai.com/v1" },
	{
		providerId: "gemini",
		host: "https://generativelanguage.googleapis.com",
		versioned: "https://generativelanguage.googleapis.com/v1beta",
	},
];

describe.each(KNOWN_PROVIDERS)(
	"normalizeBaseUrlForProvider ($providerId)",
	({ providerId, host, versioned }) => {
		it("corrects a bare host to the versioned form", () => {
			expect(normalizeBaseUrlForProvider(providerId, host)).toBe(versioned);
		});

		it("corrects a bare host with a trailing slash", () => {
			expect(normalizeBaseUrlForProvider(providerId, `${host}/`)).toBe(versioned);
		});

		it("corrects a bare host with surrounding whitespace", () => {
			expect(normalizeBaseUrlForProvider(providerId, `  ${host}  `)).toBe(versioned);
		});

		it("corrects a bare host with both a trailing slash and surrounding whitespace", () => {
			expect(normalizeBaseUrlForProvider(providerId, `  ${host}/  `)).toBe(versioned);
		});

		it("leaves an already-versioned host unchanged", () => {
			expect(normalizeBaseUrlForProvider(providerId, versioned)).toBe(versioned);
		});
	},
);

describe("normalizeBaseUrlForProvider: custom hosts", () => {
	it("returns a custom host unchanged", () => {
		const custom = "https://my-proxy.example/anthropic";
		expect(normalizeBaseUrlForProvider("anthropic", custom)).toBe(custom);
	});

	it("returns a custom host with a trailing slash byte-for-byte unchanged", () => {
		const custom = "https://my-proxy.example/anthropic/";
		expect(normalizeBaseUrlForProvider("anthropic", custom)).toBe(custom);
	});

	it("returns a custom host with surrounding whitespace byte-for-byte unchanged", () => {
		const custom = "  https://my-proxy.example/anthropic  ";
		expect(normalizeBaseUrlForProvider("anthropic", custom)).toBe(custom);
	});

	it("returns an already-versioned host with surrounding whitespace byte-for-byte unchanged", () => {
		const custom = "  https://api.anthropic.com/v1  ";
		expect(normalizeBaseUrlForProvider("anthropic", custom)).toBe(custom);
	});
});

describe("normalizeBaseUrlForProvider: unknown providers", () => {
	it("returns a bare host unchanged for a provider with no known-host policy (deepseek)", () => {
		const url = "https://api.deepseek.com";
		expect(normalizeBaseUrlForProvider("deepseek", url)).toBe(url);
	});

	it("returns a bare host unchanged for a provider with no known-host policy (bedrock)", () => {
		const url = "https://bedrock-runtime.us-east-1.amazonaws.com";
		expect(normalizeBaseUrlForProvider("bedrock", url)).toBe(url);
	});
});

describe("normalizeBaseUrlForProvider: totality", () => {
	it("never returns undefined; empty string in, empty string out", () => {
		expect(normalizeBaseUrlForProvider("anthropic", "")).toBe("");
	});
});
