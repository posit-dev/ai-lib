/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from "fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createConfigFileFixture } from "../../tests/helpers/config-file-fixture.js";
import type { ConfigFileFixture } from "../../tests/helpers/config-file-fixture.js";
import { loadProviderCatalogReport, loadResolvedProviderCatalog } from "../node/load-catalog.js";
import { readEnvFragment } from "../node/load-config.js";
import type { ResolvedProvider } from "../types.js";
import { BUILTIN_PROVIDER_IDS } from "../vocabulary.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockLogger = {
	debug: vi.fn(),
	warn: vi.fn(),
};

function findProvider(
	catalog: readonly ResolvedProvider[],
	id: string,
): ResolvedProvider | undefined {
	return catalog.find((p) => (p.id as string) === id);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadResolvedProviderCatalog", () => {
	let fixture: ConfigFileFixture;
	let configPath: string;

	beforeEach(async () => {
		fixture = await createConfigFileFixture();
		configPath = fixture.configPath;
		vi.clearAllMocks();
		vi.unstubAllEnvs();
	});

	afterEach(async () => {
		await fixture.cleanup();
	});

	// ========================================================================
	// Basic loading
	// ========================================================================

	describe("basic loading", () => {
		it.each([
			[
				"root",
				'{"__proto__":{},"providers":{"openai":{"baseUrl":"https://openai.example.com"}}}',
				["__proto__"],
			],
			[
				"providers map",
				'{"providers":{"__proto__":{},"openai":{"baseUrl":"https://openai.example.com"}}}',
				["providers", "__proto__"],
			],
			[
				"built-in provider block",
				'{"providers":{"anthropic":{"baseUrl":"https://discarded.example.com","__proto__":{}},"openai":{"baseUrl":"https://openai.example.com"}}}',
				["providers", "anthropic"],
			],
			[
				"custom provider entry",
				'{"providers":{"custom":{"gateway":{"type":"openai-compatible","__proto__":{}}},"openai":{"baseUrl":"https://openai.example.com"}}}',
				["providers", "custom", "gateway"],
			],
		] as const)("reports a raw unsafe key at the %s", async (_name, raw, issuePath) => {
			await fixture.writeRawJsonc(raw);

			const report = await loadProviderCatalogReport({
				configPath,
			});

			expect(findProvider(report.catalog, "openai")?.connection.baseUrl).toBe(
				"https://openai.example.com",
			);
			expect(report.issues).toEqual([
				expect.objectContaining({
					path: issuePath,
					message: expect.stringContaining("__proto__"),
				}),
			]);
		});

		it("reports a raw unsafe custom-provider key without losing valid siblings", async () => {
			await fixture.writeRawJsonc(
				'{"providers":{"anthropic":{"baseUrl":"https://anthropic.example.com"},"custom":{"__proto__":{"type":"openai-compatible"}}}}',
			);

			const report = await loadProviderCatalogReport({
				configPath,
				logger: mockLogger,
			});

			expect(findProvider(report.catalog, "anthropic")?.connection.baseUrl).toBe(
				"https://anthropic.example.com",
			);
			expect(report.issues).toEqual([
				expect.objectContaining({
					path: ["providers", "custom", "__proto__"],
					source: { kind: "user", label: configPath },
					message: expect.stringContaining("unsafe"),
				}),
			]);
		});

		it("keeps valid provider blocks when an unknown provider key is present", async () => {
			await fixture.writeRawJsonc(
				JSON.stringify({
					providers: {
						anthropic: { baseUrl: "https://anthropic.example.com" },
						"mystery-provider": { baseUrl: "https://unknown.example.com" },
					},
				}),
			);

			const report = await loadProviderCatalogReport({
				configPath,
				logger: mockLogger,
			});

			expect(findProvider(report.catalog, "anthropic")?.connection.baseUrl).toBe(
				"https://anthropic.example.com",
			);
			expect(report.issues).toEqual([
				expect.objectContaining({
					severity: "warning",
					path: ["providers", "mystery-provider"],
					source: { kind: "user", label: configPath },
					message: expect.stringContaining("mystery-provider"),
				}),
			]);
			expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("mystery-provider"));
		});

		it("loads comments and trailing commas from providers.json", async () => {
			await fixture.writeRawJsonc(
				`{
					// Keep the staging endpoint explicit.
					"providers": {
						"positai": {
							/* This value must survive JSONC parsing. */
							"enabled": true,
							"baseUrl": "https://staging.example.com",
						},
					},
				}`,
			);

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				logger: mockLogger,
			});

			expect(findProvider(catalog, "positai")?.enabled).toBe(true);
			expect(findProvider(catalog, "positai")?.connection.baseUrl).toBe(
				"https://staging.example.com",
			);
		});

		it("should return all built-in providers when file is missing", async () => {
			const catalog = await loadResolvedProviderCatalog({
				configPath,
				logger: mockLogger,
			});

			expect(catalog.length).toBe(BUILTIN_PROVIDER_IDS.length);
			expect(findProvider(catalog, "positai")?.enabled).toBe(true);
			expect(findProvider(catalog, "anthropic")?.enabled).toBe(true);
		});

		it("should return all built-in providers for empty config", async () => {
			await fixture.writeTypedConfig({});

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				logger: mockLogger,
			});

			expect(catalog.length).toBe(BUILTIN_PROVIDER_IDS.length);
		});
	});

	// ========================================================================
	// Enablement resolution
	// ========================================================================

	describe("enablement resolution", () => {
		it("user per-provider enabled overrides default", async () => {
			await fixture.writeTypedConfig({
				providers: {
					default: { enabled: false },
					anthropic: { enabled: true },
				},
			});

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				logger: mockLogger,
			});

			expect(findProvider(catalog, "anthropic")?.enabled).toBe(true);
			expect(findProvider(catalog, "openai")?.enabled).toBe(false);
		});

		it("user default disables providers without per-provider blocks", async () => {
			await fixture.writeTypedConfig({
				providers: {
					default: { enabled: false },
				},
			});

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				logger: mockLogger,
			});

			expect(findProvider(catalog, "anthropic")?.enabled).toBe(false);
		});
	});

	// ========================================================================
	// Enforcement
	// ========================================================================

	describe("enforcement", () => {
		it("enforced per-provider enabled overrides user config", async () => {
			await fixture.writeTypedConfig({
				providers: {
					anthropic: { enabled: true },
				},
			});

			vi.stubEnv(
				"TEST_ENFORCED",
				JSON.stringify({
					providers: {
						anthropic: { enabled: false },
					},
				}),
			);

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				enforcedEnvVar: "TEST_ENFORCED",
				logger: mockLogger,
			});

			expect(findProvider(catalog, "anthropic")?.enabled).toBe(false);
		});

		it("enforced connection config overrides user config", async () => {
			await fixture.writeTypedConfig({
				providers: {
					anthropic: { baseUrl: "https://user.example.com" },
				},
			});

			vi.stubEnv(
				"TEST_ENFORCED",
				JSON.stringify({
					providers: {
						anthropic: { baseUrl: "https://enforced.example.com" },
					},
				}),
			);

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				enforcedEnvVar: "TEST_ENFORCED",
				logger: mockLogger,
			});

			expect(findProvider(catalog, "anthropic")?.connection.baseUrl).toBe(
				"https://enforced.example.com",
			);
		});

		it("invalid enforced env var is ignored with warning", async () => {
			await fixture.writeTypedConfig({});

			vi.stubEnv("TEST_ENFORCED", "not valid json{{{");

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				enforcedEnvVar: "TEST_ENFORCED",
				logger: mockLogger,
			});

			expect(catalog.length).toBe(BUILTIN_PROVIDER_IDS.length);
			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining("Failed to parse TEST_ENFORCED"),
			);
		});

		it("enforced fragment can disable a custom provider without specifying type", async () => {
			// An admin can enforce `providers.custom.my-gateway.enabled = false`
			// without repeating the required `type` field, as long as the user
			// config already defines the full custom entry.
			await fixture.writeTypedConfig({
				providers: {
					custom: {
						"my-gateway": {
							type: "openai-compatible",
							baseUrl: "https://my-gateway.example.com",
							enabled: true,
						},
					},
				},
			});

			vi.stubEnv(
				"TEST_ENFORCED",
				JSON.stringify({
					providers: {
						custom: {
							"my-gateway": { enabled: false },
						},
					},
				}),
			);

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				enforcedEnvVar: "TEST_ENFORCED",
				logger: mockLogger,
			});

			const gateway = findProvider(catalog, "my-gateway");
			expect(gateway?.enabled).toBe(false);
			// Connection config should still be present from user config
			expect(gateway?.connection.baseUrl).toBe("https://my-gateway.example.com");
		});

		it("enforced-only custom entry without type degrades to user config", async () => {
			// If the enforced fragment introduces a custom provider without `type`
			// and the user config doesn't define it either, the merged result is
			// invalid. The enforced fragment should be ignored with a warning.
			await fixture.writeTypedConfig({
				providers: {
					anthropic: { enabled: true },
				},
			});

			vi.stubEnv(
				"TEST_ENFORCED",
				JSON.stringify({
					providers: {
						custom: {
							"env-only-gateway": { enabled: false },
						},
					},
				}),
			);

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				enforcedEnvVar: "TEST_ENFORCED",
				logger: mockLogger,
			});

			// Should fall back to user config (no custom provider)
			expect(catalog.length).toBe(BUILTIN_PROVIDER_IDS.length);
			expect(findProvider(catalog, "env-only-gateway")).toBeUndefined();
			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining("invalid merged result"),
			);
		});
	});

	// ========================================================================
	// Default env layer (POSIT_AI_PROVIDERS_DEFAULT)
	// ========================================================================

	describe("default env layer", () => {
		it("default layer applies when user file is silent", async () => {
			await fixture.writeTypedConfig({});

			vi.stubEnv("TEST_DEFAULT", JSON.stringify({ providers: { default: { enabled: false } } }));

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				defaultEnvVar: "TEST_DEFAULT",
				logger: mockLogger,
			});

			expect(findProvider(catalog, "anthropic")?.enabled).toBe(false);
		});

		it("user file overrides the default layer", async () => {
			await fixture.writeTypedConfig({
				providers: { anthropic: { enabled: true } },
			});

			vi.stubEnv("TEST_DEFAULT", JSON.stringify({ providers: { default: { enabled: false } } }));

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				defaultEnvVar: "TEST_DEFAULT",
				logger: mockLogger,
			});

			// user per-provider wins over default's default.enabled=false
			expect(findProvider(catalog, "anthropic")?.enabled).toBe(true);
			// openai has no user value → falls through to default layer
			expect(findProvider(catalog, "openai")?.enabled).toBe(false);
		});

		it("enforced still wins over the default layer", async () => {
			await fixture.writeTypedConfig({});

			vi.stubEnv("TEST_DEFAULT", JSON.stringify({ providers: { anthropic: { enabled: true } } }));
			vi.stubEnv("TEST_ENFORCED", JSON.stringify({ providers: { anthropic: { enabled: false } } }));

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				enforcedEnvVar: "TEST_ENFORCED",
				defaultEnvVar: "TEST_DEFAULT",
				logger: mockLogger,
			});

			expect(findProvider(catalog, "anthropic")?.enabled).toBe(false);
		});
	});

	// ========================================================================
	// Env fragments keep recognized rules
	// ========================================================================

	describe("env fragments keep recognized rules", () => {
		const enforcedSource = { kind: "enforced", label: "TEST_ENFORCED" } as const;

		async function loadWithEnforced(payload: unknown) {
			await fixture.writeTypedConfig({ providers: { anthropic: { enabled: true } } });
			return loadProviderCatalogReport({
				configPath,
				enforcedEnvVar: "TEST_ENFORCED",
				envVars: { TEST_ENFORCED: JSON.stringify(payload) },
			});
		}

		function enforcedBlock(payload: unknown, providerId: "anthropic" | "openai") {
			const report = readEnvFragment("enforced", "TEST_ENFORCED", {
				TEST_ENFORCED: JSON.stringify(payload),
			});
			return report.source?.config.providers?.[providerId];
		}

		it("enforced: unknown root key keeps the provider rules", async () => {
			const payload = {
				providers: { anthropic: { enabled: false } },
				agents: { claude: { enabled: false } },
			};
			const report = await loadWithEnforced(payload);

			expect(findProvider(report.catalog, "anthropic")?.enabled).toBe(false);
			expect(enforcedBlock(payload, "anthropic")).toEqual({ enabled: false });
			expect(report.issues).toEqual([
				expect.objectContaining({ severity: "warning", source: enforcedSource, path: ["agents"] }),
			]);
		});

		it("enforced: unknown provider id keeps sibling providers' rules", async () => {
			const payload = {
				providers: { anthropic: { enabled: false }, "future-provider": {} },
			};
			const report = await loadWithEnforced(payload);

			expect(findProvider(report.catalog, "anthropic")?.enabled).toBe(false);
			expect(enforcedBlock(payload, "anthropic")).toEqual({ enabled: false });
			expect(report.issues).toEqual([
				expect.objectContaining({
					severity: "warning",
					source: enforcedSource,
					path: ["providers", "future-provider"],
				}),
			]);
		});

		it("enforced: unknown field in a provider block keeps the block", async () => {
			const payload = { providers: { anthropic: { enabled: false, futureField: 1 } } };
			const report = await loadWithEnforced(payload);

			expect(findProvider(report.catalog, "anthropic")?.enabled).toBe(false);
			expect(enforcedBlock(payload, "anthropic")).toEqual({ enabled: false });
			expect(report.issues).toEqual([
				expect.objectContaining({
					severity: "warning",
					source: enforcedSource,
					path: ["providers", "anthropic", "futureField"],
				}),
			]);
		});

		it("enforced: unknown field in a models.overrides value keeps the block", async () => {
			const payload = {
				providers: {
					anthropic: {
						models: { deny: ["blocked-model"], overrides: { m: { name: "N", futureField: 1 } } },
					},
				},
			};
			const report = await loadWithEnforced(payload);

			const models = findProvider(report.catalog, "anthropic")?.models;
			expect(models?.deny).toEqual(["blocked-model"]);
			expect(models?.overrides?.["m"]?.name).toBe("N");
			expect(report.issues).toEqual([
				expect.objectContaining({
					severity: "warning",
					source: enforcedSource,
					path: ["providers", "anthropic", "models", "overrides", "m", "futureField"],
				}),
			]);
		});

		it("enforced: unknown field in a models.custom element keeps the block", async () => {
			const payload = {
				providers: {
					anthropic: {
						models: {
							deny: ["blocked-model"],
							custom: [
								{
									id: "my-model",
									name: "My Model",
									maxContextLength: 1000,
									supportsTools: true,
									supportsImages: false,
									supportsToolResultImages: false,
									supportsWebSearch: false,
									futureField: 1,
								},
							],
						},
					},
				},
			};
			const report = await loadWithEnforced(payload);

			const models = findProvider(report.catalog, "anthropic")?.models;
			expect(models?.deny).toEqual(["blocked-model"]);
			expect(models?.custom?.map((m) => m.id)).toEqual(["my-model"]);
			expect(report.issues).toEqual([
				expect.objectContaining({
					severity: "warning",
					source: enforcedSource,
					path: ["providers", "anthropic", "models", "custom", 0, "futureField"],
				}),
			]);
		});

		it("enforced: unknown field in a sub-section keeps the block", async () => {
			const payload = {
				providers: { bedrock: { aws: { region: "us-east-1", futureField: 1 } } },
			};
			const report = await loadWithEnforced(payload);

			expect(findProvider(report.catalog, "bedrock")?.connection.aws?.region).toBe("us-east-1");
			expect(report.issues).toEqual([
				expect.objectContaining({
					severity: "warning",
					source: enforcedSource,
					path: ["providers", "bedrock", "aws", "futureField"],
				}),
			]);
		});

		it("enforced: one invalid block is dropped and keeps the others", async () => {
			const payload = {
				providers: { anthropic: { enabled: false }, openai: { enabled: "no" } },
			};
			const report = await loadWithEnforced(payload);

			expect(findProvider(report.catalog, "anthropic")?.enabled).toBe(false);
			expect(enforcedBlock(payload, "openai")).toBeUndefined();
			expect(report.issues).toEqual([
				expect.objectContaining({
					severity: "warning",
					source: enforcedSource,
					path: ["providers", "openai"],
				}),
			]);
		});

		it("default env var: unknown root key keeps its provider defaults", async () => {
			await fixture.writeTypedConfig({});
			const report = await loadProviderCatalogReport({
				configPath,
				defaultEnvVar: "TEST_DEFAULT",
				envVars: {
					TEST_DEFAULT: JSON.stringify({
						providers: { default: { enabled: false } },
						agents: { claude: { enabled: false } },
					}),
				},
			});

			expect(findProvider(report.catalog, "anthropic")?.enabled).toBe(false);
			expect(report.issues).toEqual([
				expect.objectContaining({
					severity: "warning",
					source: { kind: "default", label: "TEST_DEFAULT" },
					path: ["agents"],
				}),
			]);
		});
	});

	// ========================================================================
	// Env fragment contract (plan decisions 2-5): what is kept, dropped, ignored
	// ========================================================================

	describe.each(["enforced", "default"] as const)("env fragment contract (%s)", (kind) => {
		const envVar = kind === "enforced" ? "TEST_ENFORCED" : "TEST_DEFAULT";
		const source = { kind, label: envVar } as const;

		function loadWith(raw: string) {
			return loadProviderCatalogReport({
				configPath,
				...(kind === "enforced" ? { enforcedEnvVar: envVar } : { defaultEnvVar: envVar }),
				envVars: { [envVar]: raw },
			});
		}

		function readFragment(raw: string) {
			return readEnvFragment(kind, envVar, { [envVar]: raw });
		}

		function warningAt(path: readonly (string | number)[]) {
			return expect.objectContaining({ severity: "warning", source, path });
		}

		beforeEach(async () => {
			await fixture.writeTypedConfig({});
		});

		it.each([
			{
				name: "version 2 with otherwise valid rules",
				raw: JSON.stringify({ version: 2, providers: { anthropic: { enabled: false } } }),
				message: `Unsupported ${envVar} version; expected 1. Ignoring.`,
			},
			{
				name: "array root",
				raw: "[]",
				message: `${envVar} must contain a JSON object. Ignoring.`,
			},
			{
				name: "string root",
				raw: '"x"',
				message: `${envVar} must contain a JSON object. Ignoring.`,
			},
			{
				name: "array providers",
				raw: '{"providers":[]}',
				message: `"providers" in ${envVar} must be an object of provider blocks. Ignoring.`,
			},
		])("ignores the whole payload with one error: $name", async ({ raw, message }) => {
			const report = await loadWith(raw);

			expect(findProvider(report.catalog, "anthropic")?.enabled).toBe(true);
			expect(report.issues).toEqual([{ severity: "error", source, path: [], message }]);
		});

		it("ignores an unparseable payload whole, with an error naming the var", async () => {
			const report = await loadWith("not valid json{{{");

			expect(report.issues).toEqual([
				expect.objectContaining({
					severity: "error",
					source,
					path: [],
					message: expect.stringContaining(`Failed to parse ${envVar} as JSON`),
				}),
			]);
		});

		it("never quotes the payload in a JSON parse error", () => {
			const report = readFragment('{"providers":{"openai":{"apiKey": sk-SEEDED-SECRET-123}}}');

			expect(report.issues).toEqual([
				{
					severity: "error",
					source,
					path: [],
					message: `Failed to parse ${envVar} as JSON. Ignoring.`,
				},
			]);
		});

		it("removes an unknown endpoints protocol key and keeps the other endpoints", async () => {
			const report = readFragment(
				JSON.stringify({
					providers: {
						anthropic: {
							endpoints: {
								"openai-chat": "https://a.example",
								"future-protocol": "https://b.example",
							},
						},
					},
				}),
			);

			expect(report.source?.config.providers?.anthropic?.endpoints).toEqual({
				"openai-chat": "https://a.example",
			});
			expect(report.issues).toEqual([
				warningAt(["providers", "anthropic", "endpoints", "future-protocol"]),
			]);
		});

		it.each([
			{ name: "protocol", block: { protocol: "future-protocol", enabled: false } },
			{ name: "model protocol", block: { models: { overrides: { m: { protocol: "future" } } } } },
		])("drops only the block holding an unrecognized $name value", async ({ block }) => {
			const report = await loadWith(
				JSON.stringify({ providers: { anthropic: { enabled: false }, openai: block } }),
			);

			expect(findProvider(report.catalog, "anthropic")?.enabled).toBe(false);
			expect(findProvider(report.catalog, "openai")?.enabled).toBe(true);
			expect(report.issues).toEqual([warningAt(["providers", "openai"])]);
		});

		it("drops only the custom entry holding an unrecognized type value", async () => {
			const report = readFragment(
				JSON.stringify({
					providers: {
						custom: {
							"bad-gateway": { type: "future-kind", enabled: false },
							"ok-gateway": { enabled: false },
						},
					},
				}),
			);

			expect(Object.keys(report.source?.config.providers?.custom ?? {})).toEqual(["ok-gateway"]);
			expect(report.issues).toEqual([warningAt(["providers", "custom", "bad-gateway"])]);
		});

		it.each([
			{ name: "models as an array", block: { models: [] } },
			{ name: "models.overrides as an array", block: { models: { overrides: [] } } },
			{ name: "null field", block: { enabled: null } },
			{ name: "models.custom as an object", block: { models: { custom: {} } } },
		])("drops the block with $name and keeps a valid sibling", async ({ block }) => {
			const report = await loadWith(
				JSON.stringify({ providers: { anthropic: { enabled: false }, openai: block } }),
			);

			expect(findProvider(report.catalog, "anthropic")?.enabled).toBe(false);
			expect(findProvider(report.catalog, "openai")?.enabled).toBe(true);
			expect(report.issues).toEqual([warningAt(["providers", "openai"])]);
		});

		it("drops a block with __proto__ under an unknown field and keeps a sibling", async () => {
			// Hand-built so JSON.parse creates an own `__proto__` key.
			const report = await loadWith(
				'{"providers":{"anthropic":{"enabled":false},"openai":{"enabled":false,"futureField":{"__proto__":{"x":1}}}}}',
			);

			expect(findProvider(report.catalog, "anthropic")?.enabled).toBe(false);
			expect(findProvider(report.catalog, "openai")?.enabled).toBe(true);
			expect(report.issues).toEqual([warningAt(["providers", "openai"])]);
		});

		it("drops an unsafe custom provider name before copying and keeps sibling entries", async () => {
			const report = readFragment(
				'{"providers":{"custom":{"__proto__":{"enabled":false},"ok-gateway":{"enabled":false}}}}',
			);

			expect(Object.keys(report.source?.config.providers?.custom ?? {})).toEqual(["ok-gateway"]);
			expect(report.issues).toEqual([warningAt(["providers", "custom", "__proto__"])]);
		});
	});

	describe("env fragment contract (custom entries)", () => {
		it("enforced custom entry with an unknown field stays disabled; only that field warns", async () => {
			await fixture.writeTypedConfig({
				providers: {
					custom: {
						"my-gateway": {
							type: "openai-compatible",
							baseUrl: "https://my-gateway.example.com",
							enabled: true,
						},
					},
				},
			});

			const report = await loadProviderCatalogReport({
				configPath,
				enforcedEnvVar: "TEST_ENFORCED",
				envVars: {
					TEST_ENFORCED: JSON.stringify({
						providers: { custom: { "my-gateway": { enabled: false, futureField: 1 } } },
					}),
				},
			});

			expect(findProvider(report.catalog, "my-gateway")?.enabled).toBe(false);
			expect(report.issues).toEqual([
				expect.objectContaining({
					severity: "warning",
					source: { kind: "enforced", label: "TEST_ENFORCED" },
					path: ["providers", "custom", "my-gateway", "futureField"],
				}),
			]);
		});
	});

	// ========================================================================
	// Client kind mapping (must-fix: id ≠ clientKind for some built-ins)
	// ========================================================================

	describe("client kind mapping", () => {
		it("should map bedrock to aws client kind", async () => {
			await fixture.writeTypedConfig({});

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				logger: mockLogger,
			});

			expect(findProvider(catalog, "bedrock")?.clientKind).toBe("aws");
		});

		it("should map snowflake-cortex to snowflake client kind", async () => {
			await fixture.writeTypedConfig({});

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				logger: mockLogger,
			});

			expect(findProvider(catalog, "snowflake-cortex")?.clientKind).toBe("snowflake");
		});

		it("should use identity mapping for providers where id matches client kind", async () => {
			await fixture.writeTypedConfig({});

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				logger: mockLogger,
			});

			expect(findProvider(catalog, "anthropic")?.clientKind).toBe("anthropic");
			expect(findProvider(catalog, "openai")?.clientKind).toBe("openai");
			expect(findProvider(catalog, "positai")?.clientKind).toBe("positai");
			expect(findProvider(catalog, "ollama")?.clientKind).toBe("ollama");
		});
	});

	// ========================================================================
	// Connection defaults
	// ========================================================================

	describe("connection defaults", () => {
		it("should apply built-in defaults for positai", async () => {
			await fixture.writeTypedConfig({});

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				logger: mockLogger,
			});

			const positai = findProvider(catalog, "positai");
			expect(positai?.connection.baseUrl).toBe("https://gateway.posit.ai");
			expect(positai?.connection.positaiLogin?.host).toBe("login.posit.cloud");
		});

		it("should apply built-in defaults for ollama", async () => {
			await fixture.writeTypedConfig({});

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				logger: mockLogger,
			});

			const ollama = findProvider(catalog, "ollama");
			expect(ollama?.connection.endpoint).toBe("http://localhost:11434");
		});

		it("user config should override defaults", async () => {
			await fixture.writeTypedConfig({
				providers: {
					ollama: { endpoint: "http://custom:11434" },
				},
			});

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				logger: mockLogger,
			});

			expect(findProvider(catalog, "ollama")?.connection.endpoint).toBe("http://custom:11434");
		});
	});

	// ========================================================================
	// Custom providers
	// ========================================================================

	describe("custom providers", () => {
		it("should include custom providers in the catalog", async () => {
			await fixture.writeTypedConfig({
				providers: {
					custom: {
						"my-gateway": {
							type: "openai-compatible",
							baseUrl: "https://my-gateway.example.com/v1",
						},
					},
				},
			});

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				logger: mockLogger,
			});

			// built-ins + 1 custom
			expect(catalog.length).toBe(BUILTIN_PROVIDER_IDS.length + 1);

			const custom = findProvider(catalog, "my-gateway");
			expect(custom).toBeDefined();
			expect(custom?.clientKind).toBe("openai-compatible");
			expect(custom?.connection.baseUrl).toBe("https://my-gateway.example.com/v1");
			expect(custom?.enabled).toBe(true); // no enabled key: enabled by default
		});

		it("custom providers respect enablement", async () => {
			await fixture.writeTypedConfig({
				providers: {
					default: { enabled: false },
					custom: {
						"my-gateway": {
							type: "openai-compatible",
							enabled: true,
						},
					},
				},
			});

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				logger: mockLogger,
			});

			expect(findProvider(catalog, "my-gateway")?.enabled).toBe(true);
			expect(findProvider(catalog, "anthropic")?.enabled).toBe(false);
		});
	});

	// ========================================================================
	// Model policy
	// ========================================================================

	describe("model policy", () => {
		it("should carry model policy on provider entries", async () => {
			await fixture.writeTypedConfig({
				providers: {
					anthropic: {
						models: {
							discovery: "auto",
							deny: ["claude-3-haiku-20240307"],
							overrides: {
								"claude-sonnet-4-20250514": {
									name: "Sonnet 4",
								},
							},
						},
					},
				},
			});

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				logger: mockLogger,
			});

			const anthropic = findProvider(catalog, "anthropic");
			expect(anthropic?.models?.discovery).toBe("auto");
			expect(anthropic?.models?.deny).toEqual(["claude-3-haiku-20240307"]);
			expect(anthropic?.models?.overrides?.["claude-sonnet-4-20250514"]?.name).toBe("Sonnet 4");
		});
	});

	// ========================================================================
	// Validation errors
	// ========================================================================

	describe("validation errors", () => {
		it("should degrade gracefully on invalid JSON", async () => {
			await fixture.writeRawJsonc("not valid json{{{");

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				logger: mockLogger,
			});

			expect(catalog.length).toBe(BUILTIN_PROVIDER_IDS.length); // defaults
			expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Invalid JSONC"));
		});

		it("should degrade gracefully on schema violation", async () => {
			await fixture.writeRawJsonc(JSON.stringify({ version: 99 }));

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				logger: mockLogger,
			});

			expect(catalog.length).toBe(BUILTIN_PROVIDER_IDS.length); // defaults
			expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Validation errors"));
		});

		it("should degrade gracefully on a forbidden connection subsection", async () => {
			// `anthropic.aws` is rejected by the tightened per-key schema. The whole
			// user file is invalid and must fall back to defaults, not hard-crash.
			await fixture.writeRawJsonc(
				JSON.stringify({ providers: { anthropic: { aws: { region: "us-east-1" } } } }),
			);

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				logger: mockLogger,
			});

			expect(catalog.length).toBe(BUILTIN_PROVIDER_IDS.length); // defaults
			expect(findProvider(catalog, "anthropic")?.connection.aws).toBeUndefined();
			expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Validation errors"));
		});
	});

	// ========================================================================
	// Whole-source failure severity and error locations
	// ========================================================================

	describe("whole-source failures", () => {
		it("reports a syntax error as an error-severity issue with line and column", async () => {
			// Missing comma after the `providers` block: the parser reports
			// CommaExpected at the `"version"` token on line 3.
			await fixture.writeRawJsonc('{\n  "providers": {}\n  "version": 1\n}\n');

			const report = await loadProviderCatalogReport({
				configPath,
			});

			expect(report.issues).toEqual([
				expect.objectContaining({
					severity: "error",
					path: [],
					source: { kind: "user", label: configPath },
					message: expect.stringContaining("Invalid JSONC: CommaExpected at line 3, column 3"),
				}),
			]);
		});

		it("reports line 1 for a single-line syntax error", async () => {
			await fixture.writeRawJsonc("{ bad");

			const report = await loadProviderCatalogReport({
				configPath,
			});

			expect(report.issues).toEqual([
				expect.objectContaining({
					severity: "error",
					message: expect.stringContaining("at line 1, column"),
				}),
			]);
		});

		it.each([
			["CRLF", "\r\n"],
			["CR-only", "\r"],
		] as const)("reports the correct line and column with %s line endings", async (_name, eol) => {
			// Missing comma after the `providers` block: CommaExpected at the
			// `"version"` token on line 3, regardless of line-ending style.
			await fixture.writeRawJsonc(["{", '  "providers": {}', '  "version": 1', "}", ""].join(eol));

			const report = await loadProviderCatalogReport({
				configPath,
			});

			expect(report.issues).toEqual([
				expect.objectContaining({
					severity: "error",
					message: expect.stringContaining("at line 3, column 3"),
				}),
			]);
		});

		it("reports an unreadable file as an error-severity issue", async () => {
			await fixture.writeTypedConfig({});
			const readError = Object.assign(new Error("permission denied"), { code: "EACCES" });
			const readSpy = vi.spyOn(fs, "readFile").mockRejectedValueOnce(readError);

			const report = await loadProviderCatalogReport({
				configPath,
			});

			readSpy.mockRestore();
			expect(report.issues).toEqual([
				expect.objectContaining({
					severity: "error",
					path: [],
					source: { kind: "user", label: configPath },
					message: expect.stringContaining("Could not read the file: permission denied"),
				}),
			]);
		});

		it("reports an unparseable env fragment as an error-severity issue", async () => {
			await fixture.writeTypedConfig({});

			const report = await loadProviderCatalogReport({
				configPath,
				enforcedEnvVar: "TEST_ENFORCED",
				envVars: { TEST_ENFORCED: "not valid json{{{" },
			});

			expect(report.issues).toEqual([
				expect.objectContaining({
					severity: "error",
					source: { kind: "enforced", label: "TEST_ENFORCED" },
					message: expect.stringContaining("Failed to parse TEST_ENFORCED as JSON"),
				}),
			]);
		});
	});

	// ========================================================================
	// PROVIDER-SETTINGS-MIGRATION(legacy-positron) gate: delete this block
	// with the loader option. Legacy layers folded into the LOAD path.
	// ========================================================================

	describe("legacyPositronSettings", () => {
		const fakeReader = (values: Record<string, unknown>) => ({
			get: (key: string) => values[key],
			watch: () => ({ dispose: () => {} }),
		});

		it("folds the reader layer into the initial load (below user, above default)", async () => {
			// providers.json (user) sets openai's base URL; the legacy reader sets
			// anthropic's and openai's. Both providers must resolve in the initial
			// catalog — the load path reads the legacy layers, not just the watch
			// path.
			await fixture.writeTypedConfig({
				providers: { openai: { baseUrl: "https://user-openai.example.com" } },
			});

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				logger: mockLogger,
				legacyPositronSettings: fakeReader({
					"authentication.anthropic.baseUrl": "https://legacy-anthropic.example.com",
					"authentication.openai-api.baseUrl": "https://legacy-openai.example.com",
				}),
			});

			// Legacy contributes anthropic (user silent → legacy wins over default).
			expect(findProvider(catalog, "anthropic")?.connection.baseUrl).toBe(
				"https://legacy-anthropic.example.com",
			);
			// user wins over legacy for openai.
			expect(findProvider(catalog, "openai")?.connection.baseUrl).toBe(
				"https://user-openai.example.com",
			);
		});

		it("legacyPositronEnforcedSettings folds the enforced env layer into the initial load (above user), without a reader", async () => {
			await fixture.writeTypedConfig({
				providers: { anthropic: { baseUrl: "https://user.example.com" } },
			});

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				logger: mockLogger,
				envVars: {
					POSITRON_ENFORCED_SETTINGS: JSON.stringify({
						"authentication.anthropic.baseUrl": "https://enforced.example.com",
					}),
				},
				legacyPositronEnforcedSettings: true,
			});

			expect(findProvider(catalog, "anthropic")?.connection.baseUrl).toBe(
				"https://enforced.example.com",
			);
		});

		it("the reader alone does not enable the enforced layer", async () => {
			// Migrated Positron hosts drop the reader but keep the enforced flag;
			// pre-migration hosts pass both. A reader must therefore never smuggle
			// the enforced layer in (the pre-split behavior).
			await fixture.writeTypedConfig({
				providers: { anthropic: { baseUrl: "https://user.example.com" } },
			});

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				logger: mockLogger,
				envVars: {
					POSITRON_ENFORCED_SETTINGS: JSON.stringify({
						"authentication.anthropic.baseUrl": "https://enforced.example.com",
					}),
				},
				legacyPositronSettings: fakeReader({}),
			});

			expect(findProvider(catalog, "anthropic")?.connection.baseUrl).toBe(
				"https://user.example.com",
			);
		});

		it("options absent → neither legacy layer (even with the env var set)", async () => {
			await fixture.writeTypedConfig({ providers: {} });

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				logger: mockLogger,
				envVars: {
					POSITRON_ENFORCED_SETTINGS: JSON.stringify({
						"authentication.anthropic.baseUrl": "https://enforced.example.com",
					}),
				},
			});

			expect(catalog.length).toBe(BUILTIN_PROVIDER_IDS.length);
			expect(findProvider(catalog, "anthropic")?.connection.baseUrl).toBeUndefined();
		});

		it("a reader with nothing set contributes no layer", async () => {
			await fixture.writeTypedConfig({ providers: {} });

			const catalog = await loadResolvedProviderCatalog({
				configPath,
				logger: mockLogger,
				legacyPositronSettings: fakeReader({}),
			});

			expect(catalog.length).toBe(BUILTIN_PROVIDER_IDS.length);
			expect(findProvider(catalog, "anthropic")?.connection.baseUrl).toBeUndefined();
		});

		it("returns recurring legacy issues on every read until the setting is fixed", async () => {
			await fixture.writeTypedConfig({});
			let values: Record<string, unknown> = { "authentication.anthropic.baseUrl": 42 };
			const reader = {
				get: (key: string) => values[key],
				watch: () => ({ dispose: () => {} }),
			};
			const opts = {
				configPath,
				legacyPositronSettings: reader,
			};

			const first = await loadProviderCatalogReport(opts);
			const second = await loadProviderCatalogReport(opts);
			expect(first.issues).toEqual(second.issues);
			expect(first.issues).toEqual([
				expect.objectContaining({
					source: { kind: "legacy-positron", label: "legacy Positron settings" },
					message: expect.stringContaining("expected a string"),
				}),
			]);

			values = {};
			expect((await loadProviderCatalogReport(opts)).issues).toEqual([]);
		});
	});

	describe("hostDefaults", () => {
		it("folds hostDefaults below the user file", async () => {
			await fixture.writeTypedConfig({
				providers: { positai: { positaiLogin: { host: "login.example.test" } } },
			});
			const catalog = await loadResolvedProviderCatalog({
				configPath,
				envVars: {},
				hostDefaults: { providers: { positai: { positaiLogin: { clientId: "positron" } } } },
			});
			const positai = findProvider(catalog, "positai");
			expect(positai?.connection.positaiLogin).toEqual({
				host: "login.example.test",
				clientId: "positron",
				scope: "prism",
			});
		});

		it("lets the user file override a hostDefaults value", async () => {
			await fixture.writeTypedConfig({
				providers: { positai: { positaiLogin: { clientId: "mine" } } },
			});
			const catalog = await loadResolvedProviderCatalog({
				configPath,
				envVars: {},
				hostDefaults: { providers: { positai: { positaiLogin: { clientId: "positron" } } } },
			});
			expect(findProvider(catalog, "positai")?.connection.positaiLogin?.clientId).toBe("mine");
		});
	});
});
