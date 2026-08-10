/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { salvageProvidersConfig } from "../salvage-config.js";
import { providersConfigFragmentSchema, providersConfigSchema } from "../schema.js";
import { BUILTIN_PROVIDER_IDS } from "../vocabulary.js";

describe("salvageProvidersConfig", () => {
	it("uses the healthy full-schema fast path", () => {
		const input = { version: 1, providers: { anthropic: { enabled: true } } };
		const report = salvageProvidersConfig(input);
		expect(report).toEqual({ config: input, issues: [] });
	});

	it("accepts every canonical built-in provider id", () => {
		const providers = Object.fromEntries(BUILTIN_PROVIDER_IDS.map((id) => [id, {}]));
		expect(salvageProvidersConfig({ providers }).issues).toEqual([]);
	});

	it.each([
		{
			name: "bad built-in block",
			input: { providers: { anthropic: { bogusField: true }, openai: { enabled: true } } },
			kept: ["openai"],
			path: ["providers", "anthropic"],
		},
		{
			name: "bad custom entry",
			input: {
				providers: {
					custom: {
						bad: { type: "not-supported" },
						good: { type: "openai-compatible", baseUrl: "https://good.example.com" },
					},
				},
			},
			kept: ["custom.good"],
			path: ["providers", "custom", "bad"],
		},
		{
			name: "unknown provider key",
			input: { providers: { "mystery-provider": {}, anthropic: { enabled: true } } },
			kept: ["anthropic"],
			path: ["providers", "mystery-provider"],
		},
		{
			name: "unknown root key",
			input: { future: true, providers: { anthropic: { enabled: true } } },
			kept: ["anthropic"],
			path: ["future"],
		},
		{
			name: "wrong schema type",
			input: { $schema: 42, providers: { anthropic: { enabled: true } } },
			kept: ["anthropic"],
			path: ["$schema"],
		},
	])("drops only the offending $name", ({ input, kept, path }) => {
		const report = salvageProvidersConfig(input);
		expect(report.issues).toHaveLength(1);
		expect(report.issues[0].path).toEqual(path);
		for (const key of kept) {
			if (key === "custom.good") {
				expect(report.config.providers?.custom?.good).toBeDefined();
			} else {
				expect(
					report.config.providers?.[key as keyof NonNullable<typeof report.config.providers>],
				).toBeDefined();
			}
		}
	});

	it.each([
		["builtin collision", "anthropic", "collides with a built-in provider id"],
		["reserved name", "default", "is a reserved key"],
		["unsafe name", "__proto__", "is unsafe"],
	] as const)("shares the strict custom-name policy for %s", (_name, customName, message) => {
		const input = {
			providers: { custom: { [customName]: { type: "openai-compatible" } } },
		};
		const strict = providersConfigSchema.safeParse(input);
		const report = salvageProvidersConfig(input);
		expect(strict.success).toBe(false);
		if (!strict.success) {
			expect(strict.error.issues[0].message).toContain(message);
		}
		expect(report.issues[0].message).toContain(message);
		expect(report.config.providers?.custom).toEqual({});
	});

	it.each([
		["root", '{"__proto__":{}}'],
		["providers map", '{"providers":{"__proto__":{}}}'],
		["built-in block", '{"providers":{"anthropic":{"__proto__":{}}}}'],
		[
			"custom entry",
			'{"providers":{"custom":{"gateway":{"type":"openai-compatible","__proto__":{}}}}}',
		],
	] as const)("strict full and fragment schemas reject __proto__ at the %s", (_name, raw) => {
		const input: unknown = JSON.parse(raw);
		expect(providersConfigSchema.safeParse(input).success).toBe(false);
		expect(providersConfigFragmentSchema.safeParse(input).success).toBe(false);
	});

	it.each([
		["wrong version", { version: 2 }],
		["primitive root", "bad"],
		["array root", []],
		["null root", null],
		["primitive providers", { providers: "bad" }],
		["array providers", { providers: [] }],
		["null providers", { providers: null }],
	] as const)("degrades %s to an empty config with an issue", (_name, input) => {
		const report = salvageProvidersConfig(input);
		expect(report.config).toEqual({});
		// Whole-file degrades are source-wide: error severity, empty path.
		expect(report.issues.length).toBeGreaterThan(0);
		expect(report.issues[0]).toMatchObject({ severity: "error", path: [] });
	});

	it("seals every reconstructed malformed fixture with the full schema", () => {
		const fixtures: unknown[] = [
			{ providers: { anthropic: { bogus: true }, openai: {} } },
			{ providers: { custom: { bad: null, good: { type: "ollama" } } } },
			{ extra: true, providers: { anthropic: {} } },
			{ $schema: false, version: 1, providers: { default: { enabled: true } } },
			{ providers: { "mystery-provider": {}, bedrock: { aws: { region: "us-east-2" } } } },
		];
		for (const fixture of fixtures) {
			expect(providersConfigSchema.safeParse(salvageProvidersConfig(fixture).config).success).toBe(
				true,
			);
		}
	});
});
