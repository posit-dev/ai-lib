/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from "vitest";

import { providersConfigSchema } from "../schema";

describe("providersConfigSchema", () => {
	it("accepts an empty config", () => {
		const result = providersConfigSchema.safeParse({});
		expect(result.success).toBe(true);
	});

	it("accepts a minimal config with version only", () => {
		const result = providersConfigSchema.safeParse({ version: 1 });
		expect(result.success).toBe(true);
	});

	it("accepts a config with $schema", () => {
		const result = providersConfigSchema.safeParse({
			$schema: "https://posit.co/ai/providers.schema.json",
			version: 1,
		});
		expect(result.success).toBe(true);
	});

	it("accepts a config with providers.default", () => {
		const result = providersConfigSchema.safeParse({
			providers: { default: { enabled: true } },
		});
		expect(result.success).toBe(true);
	});

	it("accepts a built-in provider with connection config", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				anthropic: {
					enabled: true,
					baseUrl: "https://gateway.example.com",
					customHeaders: { "x-team": "data-science" },
				},
			},
		});
		expect(result.success).toBe(true);
	});

	it("accepts a built-in provider with models block", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				anthropic: {
					models: {
						discovery: "auto",
						allow: ["claude-sonnet-4-5"],
						deny: [],
						overrides: {
							"claude-sonnet-4-5": {
								name: "Sonnet (team)",
								maxContextLength: 200000,
							},
						},
						custom: [
							{
								id: "claude-custom",
								name: "Custom",
								maxContextLength: 200000,
								supportsTools: true,
								supportsImages: true,
								supportsToolResultImages: true,
								supportsWebSearch: false,
							},
						],
					},
				},
			},
		});
		expect(result.success).toBe(true);
	});

	it("accepts providers with grouped connection sections", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				bedrock: { aws: { region: "us-west-2", profile: "default" } },
				"google-vertex": { googleCloud: { project: "my-project", location: "us-central1" } },
				"snowflake-cortex": { snowflake: { account: "MYORG-MYACCT" } },
				positai: { oauth: { host: "login.posit.cloud", clientId: "my-app" } },
			},
		});
		expect(result.success).toBe(true);
	});

	it("accepts per-protocol endpoints", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				"snowflake-cortex": {
					endpoints: {
						"anthropic-messages": "https://gw.example.com/anthropic",
						"openai-chat": "https://gw.example.com/openai",
					},
				},
			},
		});
		expect(result.success).toBe(true);
	});

	it("accepts custom providers with required type", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				custom: {
					baseten: { type: "openai-compatible" },
					myprovider: {
						type: "openai-compatible",
						baseUrl: "https://my-gateway.example.com/v1",
						protocol: "openai-chat",
					},
					aws2: { type: "aws", aws: { region: "us-east-1" } },
					"snowflake-2": { type: "snowflake", snowflake: { account: "MYORG" } },
				},
			},
		});
		expect(result.success).toBe(true);
	});

	// --- Rejections ---

	it("rejects a custom provider name that collides with a built-in id", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				custom: {
					anthropic: { type: "openai-compatible" },
				},
			},
		});
		expect(result.success).toBe(false);
	});

	it("rejects a custom provider named 'default'", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				custom: {
					default: { type: "openai-compatible" },
				},
			},
		});
		expect(result.success).toBe(false);
	});

	it("rejects a custom provider named 'custom'", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				custom: {
					custom: { type: "openai-compatible" },
				},
			},
		});
		expect(result.success).toBe(false);
	});

	it("rejects a custom provider without type", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				custom: {
					myprovider: { baseUrl: "https://example.com" },
				},
			},
		});
		expect(result.success).toBe(false);
	});

	it("rejects a custom model missing required fields", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				anthropic: {
					models: {
						custom: [
							{
								id: "partial-model",
								name: "Partial",
								// missing maxContextLength, supportsTools, etc.
							},
						],
					},
				},
			},
		});
		expect(result.success).toBe(false);
	});

	it("rejects an invalid protocol value", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				anthropic: { protocol: "invalid-protocol" },
			},
		});
		expect(result.success).toBe(false);
	});

	it("rejects type on a built-in provider block", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				anthropic: { type: "anthropic" },
			},
		});
		expect(result.success).toBe(false);
	});

	it("rejects unknown top-level keys", () => {
		const result = providersConfigSchema.safeParse({
			unknownKey: "value",
		});
		expect(result.success).toBe(false);
	});
});
