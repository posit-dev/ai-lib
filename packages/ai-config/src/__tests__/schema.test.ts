/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from "fs";

import { describe, it, expect } from "vitest";

import { serializeProvidersSchema } from "../../scripts/generate-schema.js";
import { providersConfigFragmentSchema, providersConfigSchema } from "../schema.js";

describe("providers.schema.json", () => {
	it("matches the generated schema", async () => {
		const committedSchema = await fs.readFile(
			new URL("../../providers.schema.json", import.meta.url),
			"utf-8",
		);

		expect(committedSchema).toBe(serializeProvidersSchema());
	});
});

describe("providersConfigSchema", () => {
	it("accepts an empty config", () => {
		const result = providersConfigSchema.safeParse({});
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
				positai: { positaiLogin: { host: "login.posit.cloud", clientId: "my-app" } },
			},
		});
		expect(result.success).toBe(true);
	});

	it("accepts snowflake.home on built-in and custom snowflake providers", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				"snowflake-cortex": { snowflake: { account: "MYORG-MYACCT", home: "/opt/snowflake" } },
				custom: {
					"snowflake-2": { type: "snowflake", snowflake: { home: "/opt/snowflake" } },
				},
			},
		});
		expect(result.success).toBe(true);
	});

	it("accepts baseUrl in model overrides", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				anthropic: {
					models: {
						overrides: {
							"claude-sonnet-4-5": {
								baseUrl: "https://override.example.com",
							},
						},
					},
				},
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

	it("accepts a base-only custom type:'portkey' entry", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				custom: {
					"acme-portkey": {
						type: "portkey",
						baseUrl: "https://ai-gateway.acme.com",
						customHeaders: { "x-portkey-provider": "openai" },
						protocol: "openai-chat",
					},
				},
			},
		});
		expect(result.success).toBe(true);
	});

	it.each([
		["litellm", "Authorization"],
		["litellm", "X-API-Key"],
		["portkey", "authorization"],
		["portkey", "x-api-key"],
		["portkey", "X-Portkey-API-Key"],
		["portkey", "x-portkey-virtual-key"],
	] as const)("rejects reserved %s authentication header %s", (providerId, headerName) => {
		const result = providersConfigSchema.safeParse({
			providers: {
				[providerId]: { customHeaders: { [headerName]: "must-not-be-a-secret-channel" } },
			},
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues).toEqual([
				expect.objectContaining({
					message: expect.stringContaining("reserved"),
					path: ["providers", providerId, "customHeaders", headerName],
				}),
			]);
		}
	});

	it("keeps non-secret LiteLLM and Portkey routing headers valid", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				litellm: { customHeaders: { "x-tenant": "analytics" } },
				portkey: { customHeaders: { "x-portkey-provider": "openai" } },
			},
		});

		expect(result.success).toBe(true);
	});

	// --- Per-key / discriminated-union strictness ---

	it("rejects a foreign connection section on a built-in provider (anthropic + aws)", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				anthropic: { aws: { region: "us-east-1" } },
			},
		});
		expect(result.success).toBe(false);
	});

	it("rejects a wrong capability section on a capability-bearing built-in (bedrock + snowflake)", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				bedrock: { snowflake: { account: "MYORG" } },
			},
		});
		expect(result.success).toBe(false);
	});

	it("rejects googleCloud on bedrock", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				bedrock: { googleCloud: { project: "p" } },
			},
		});
		expect(result.success).toBe(false);
	});

	it("rejects an aws section on a custom type:'openai-compatible' entry", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				custom: { gw: { type: "openai-compatible", aws: { region: "us-east-1" } } },
			},
		});
		expect(result.success).toBe(false);
	});

	it("rejects provider-specific sections on a custom type:'portkey' entry", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				custom: {
					"acme-portkey": {
						type: "portkey",
						aws: { region: "us-east-1" },
					},
				},
			},
		});
		expect(result.success).toBe(false);
	});

	it("rejects an unsupported custom type (positai)", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				custom: { gw: { type: "positai" } },
			},
		});
		expect(result.success).toBe(false);
	});

	// --- positaiLogin rename ---

	it("accepts positaiLogin on the positai key", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				positai: { positaiLogin: { host: "login.posit.cloud" } },
			},
		});
		expect(result.success).toBe(true);
	});

	it("rejects the legacy oauth section on the positai key", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				positai: { oauth: { host: "login.posit.cloud" } },
			},
		});
		expect(result.success).toBe(false);
	});

	it("rejects positaiLogin on a non-positai provider", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				anthropic: { positaiLogin: { host: "login.posit.cloud" } },
			},
		});
		expect(result.success).toBe(false);
	});

	// --- Rejections ---

	it.each(["anthropic", "default", "custom", "__proto__"])(
		"rejects reserved or unsafe custom provider name %s",
		(name) => {
			const result = providersConfigSchema.safeParse({
				providers: {
					custom: {
						[name]: { type: "openai-compatible" },
					},
				},
			});
			expect(result.success).toBe(false);
		},
	);

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

describe("providersConfigFragmentSchema", () => {
	it("accepts a bare single custom key with type omitted", () => {
		const result = providersConfigFragmentSchema.safeParse({
			providers: {
				custom: { "my-gateway": { enabled: false } },
			},
		});
		expect(result.success).toBe(true);
	});

	it("accepts an enforced custom entry with a supported type", () => {
		const result = providersConfigFragmentSchema.safeParse({
			providers: {
				custom: { "my-gateway": { type: "openai-compatible", enabled: true } },
			},
		});
		expect(result.success).toBe(true);
	});

	it("rejects an enforced custom entry with an unsupported type", () => {
		const result = providersConfigFragmentSchema.safeParse({
			providers: {
				custom: { "my-gateway": { type: "positai" } },
			},
		});
		expect(result.success).toBe(false);
	});
});
