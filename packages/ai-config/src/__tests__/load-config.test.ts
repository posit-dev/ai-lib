/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from "fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createConfigFileFixture } from "../../tests/helpers/config-file-fixture.js";
import type { ConfigFileFixture } from "../../tests/helpers/config-file-fixture.js";
import { loadProviderCatalogReport, loadResolvedProviderCatalog } from "../node/load-catalog.js";
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

		it("keeps an invalid env fragment all-or-nothing and reports its source", async () => {
			await fixture.writeTypedConfig({
				providers: { anthropic: { baseUrl: "https://user.example.com" } },
			});
			const report = await loadProviderCatalogReport({
				configPath,
				enforcedEnvVar: "TEST_ENFORCED",
				envVars: {
					TEST_ENFORCED: JSON.stringify({
						providers: {
							anthropic: { baseUrl: "https://admin.example.com" },
							"mystery-provider": {},
						},
					}),
				},
			});

			expect(findProvider(report.catalog, "anthropic")?.connection.baseUrl).toBe(
				"https://user.example.com",
			);
			expect(report.issues).toEqual([
				expect.objectContaining({
					severity: "error",
					source: { kind: "enforced", label: "TEST_ENFORCED" },
					message: expect.stringContaining("mystery-provider"),
				}),
			]);
		});

		it("ignores an env fragment containing an unsafe custom provider name", async () => {
			await fixture.writeTypedConfig({
				providers: { anthropic: { baseUrl: "https://user.example.com" } },
			});
			const report = await loadProviderCatalogReport({
				configPath,
				enforcedEnvVar: "TEST_ENFORCED",
				envVars: {
					TEST_ENFORCED:
						'{"providers":{"anthropic":{"baseUrl":"https://admin.example.com"},"custom":{"__proto__":{"enabled":false}}}}',
				},
			});

			expect(findProvider(report.catalog, "anthropic")?.connection.baseUrl).toBe(
				"https://user.example.com",
			);
			// The fragment is ignored whole, so the issue is source-wide (empty
			// path); the offending key path stays in the message prose.
			expect(report.issues).toEqual([
				expect.objectContaining({
					severity: "error",
					source: { kind: "enforced", label: "TEST_ENFORCED" },
					path: [],
					message: expect.stringContaining('Custom provider name "__proto__" is unsafe.'),
				}),
			]);
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
});
