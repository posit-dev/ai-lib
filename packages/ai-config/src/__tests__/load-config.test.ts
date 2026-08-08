/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadResolvedProviderCatalog } from "../node/load-catalog.js";
import { mutateProvidersConfig } from "../node/mutate-config.js";
import type { ProvidersConfig, ResolvedProvider } from "../types.js";
import type { PlatformBaseline } from "../types.js";
import { BUILTIN_PROVIDER_IDS } from "../vocabulary.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockLogger = {
	debug: vi.fn(),
	warn: vi.fn(),
};

/** Standalone baseline: everything enabled by default. */
const STANDALONE_BASELINE: PlatformBaseline = { defaultEnabled: true };

/** RStudio baseline: positai only. */
const RSTUDIO_BASELINE: PlatformBaseline = {
	defaultEnabled: false,
	providerOverrides: { positai: { enabled: true } },
};

async function writeConfig(dir: string, config: ProvidersConfig): Promise<string> {
	const configPath = path.join(dir, "providers.json");
	await fs.writeFile(configPath, JSON.stringify(config, null, 2));
	return configPath;
}

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
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-config-test-"));
		vi.clearAllMocks();
		vi.unstubAllEnvs();
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	// ========================================================================
	// Basic loading
	// ========================================================================

	describe("basic loading", () => {
		it("loads comments and trailing commas from providers.json", async () => {
			const configPath = path.join(tempDir, "providers.json");
			await fs.writeFile(
				configPath,
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
				baseline: { defaultEnabled: false },
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
				baseline: STANDALONE_BASELINE,
				configPath: path.join(tempDir, "nonexistent.json"),
				logger: mockLogger,
			});

			expect(catalog.length).toBe(BUILTIN_PROVIDER_IDS.length);
			expect(findProvider(catalog, "positai")?.enabled).toBe(true);
			expect(findProvider(catalog, "anthropic")?.enabled).toBe(true);
		});

		it("should return all built-in providers for empty config", async () => {
			const configPath = await writeConfig(tempDir, {});

			const catalog = await loadResolvedProviderCatalog({
				baseline: STANDALONE_BASELINE,
				configPath,
				logger: mockLogger,
			});

			expect(catalog.length).toBe(BUILTIN_PROVIDER_IDS.length);
		});

		it("should apply RStudio baseline (positai only)", async () => {
			const configPath = await writeConfig(tempDir, {});

			const catalog = await loadResolvedProviderCatalog({
				baseline: RSTUDIO_BASELINE,
				configPath,
				logger: mockLogger,
			});

			expect(findProvider(catalog, "positai")?.enabled).toBe(true);
			expect(findProvider(catalog, "anthropic")?.enabled).toBe(false);
			expect(findProvider(catalog, "openai")?.enabled).toBe(false);
		});
	});

	// ========================================================================
	// Enablement resolution
	// ========================================================================

	describe("enablement resolution", () => {
		it("user per-provider enabled overrides default", async () => {
			const configPath = await writeConfig(tempDir, {
				providers: {
					default: { enabled: false },
					anthropic: { enabled: true },
				},
			});

			const catalog = await loadResolvedProviderCatalog({
				baseline: STANDALONE_BASELINE,
				configPath,
				logger: mockLogger,
			});

			expect(findProvider(catalog, "anthropic")?.enabled).toBe(true);
			expect(findProvider(catalog, "openai")?.enabled).toBe(false);
		});

		it("user default overrides platform baseline", async () => {
			const configPath = await writeConfig(tempDir, {
				providers: {
					default: { enabled: false },
				},
			});

			const catalog = await loadResolvedProviderCatalog({
				baseline: STANDALONE_BASELINE,
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
			const configPath = await writeConfig(tempDir, {
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
				baseline: STANDALONE_BASELINE,
				configPath,
				enforcedEnvVar: "TEST_ENFORCED",
				logger: mockLogger,
			});

			expect(findProvider(catalog, "anthropic")?.enabled).toBe(false);
		});

		it("enforced connection config overrides user config", async () => {
			const configPath = await writeConfig(tempDir, {
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
				baseline: STANDALONE_BASELINE,
				configPath,
				enforcedEnvVar: "TEST_ENFORCED",
				logger: mockLogger,
			});

			expect(findProvider(catalog, "anthropic")?.connection.baseUrl).toBe(
				"https://enforced.example.com",
			);
		});

		it("invalid enforced env var is ignored with warning", async () => {
			const configPath = await writeConfig(tempDir, {});

			vi.stubEnv("TEST_ENFORCED", "not valid json{{{");

			const catalog = await loadResolvedProviderCatalog({
				baseline: STANDALONE_BASELINE,
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
			const configPath = await writeConfig(tempDir, {
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
				baseline: STANDALONE_BASELINE,
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
			const configPath = await writeConfig(tempDir, {
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
				baseline: STANDALONE_BASELINE,
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
			const configPath = await writeConfig(tempDir, {});

			vi.stubEnv("TEST_DEFAULT", JSON.stringify({ providers: { default: { enabled: false } } }));

			const catalog = await loadResolvedProviderCatalog({
				baseline: STANDALONE_BASELINE,
				configPath,
				defaultEnvVar: "TEST_DEFAULT",
				logger: mockLogger,
			});

			expect(findProvider(catalog, "anthropic")?.enabled).toBe(false);
		});

		it("user file overrides the default layer", async () => {
			const configPath = await writeConfig(tempDir, {
				providers: { anthropic: { enabled: true } },
			});

			vi.stubEnv("TEST_DEFAULT", JSON.stringify({ providers: { default: { enabled: false } } }));

			const catalog = await loadResolvedProviderCatalog({
				baseline: STANDALONE_BASELINE,
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
			const configPath = await writeConfig(tempDir, {});

			vi.stubEnv("TEST_DEFAULT", JSON.stringify({ providers: { anthropic: { enabled: true } } }));
			vi.stubEnv("TEST_ENFORCED", JSON.stringify({ providers: { anthropic: { enabled: false } } }));

			const catalog = await loadResolvedProviderCatalog({
				baseline: STANDALONE_BASELINE,
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
			const configPath = await writeConfig(tempDir, {});

			const catalog = await loadResolvedProviderCatalog({
				baseline: STANDALONE_BASELINE,
				configPath,
				logger: mockLogger,
			});

			expect(findProvider(catalog, "bedrock")?.clientKind).toBe("aws");
		});

		it("should map snowflake-cortex to snowflake client kind", async () => {
			const configPath = await writeConfig(tempDir, {});

			const catalog = await loadResolvedProviderCatalog({
				baseline: STANDALONE_BASELINE,
				configPath,
				logger: mockLogger,
			});

			expect(findProvider(catalog, "snowflake-cortex")?.clientKind).toBe("snowflake");
		});

		it("should use identity mapping for providers where id matches client kind", async () => {
			const configPath = await writeConfig(tempDir, {});

			const catalog = await loadResolvedProviderCatalog({
				baseline: STANDALONE_BASELINE,
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
			const configPath = await writeConfig(tempDir, {});

			const catalog = await loadResolvedProviderCatalog({
				baseline: STANDALONE_BASELINE,
				configPath,
				logger: mockLogger,
			});

			const positai = findProvider(catalog, "positai");
			expect(positai?.connection.baseUrl).toBe("https://gateway.posit.ai");
			expect(positai?.connection.positaiLogin?.host).toBe("login.posit.cloud");
		});

		it("should apply built-in defaults for ollama", async () => {
			const configPath = await writeConfig(tempDir, {});

			const catalog = await loadResolvedProviderCatalog({
				baseline: STANDALONE_BASELINE,
				configPath,
				logger: mockLogger,
			});

			const ollama = findProvider(catalog, "ollama");
			expect(ollama?.connection.endpoint).toBe("http://localhost:11434");
		});

		it("user config should override defaults", async () => {
			const configPath = await writeConfig(tempDir, {
				providers: {
					ollama: { endpoint: "http://custom:11434" },
				},
			});

			const catalog = await loadResolvedProviderCatalog({
				baseline: STANDALONE_BASELINE,
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
			const configPath = await writeConfig(tempDir, {
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
				baseline: STANDALONE_BASELINE,
				configPath,
				logger: mockLogger,
			});

			// built-ins + 1 custom
			expect(catalog.length).toBe(BUILTIN_PROVIDER_IDS.length + 1);

			const custom = findProvider(catalog, "my-gateway");
			expect(custom).toBeDefined();
			expect(custom?.clientKind).toBe("openai-compatible");
			expect(custom?.connection.baseUrl).toBe("https://my-gateway.example.com/v1");
			expect(custom?.enabled).toBe(true); // standalone baseline
		});

		it("custom providers respect enablement", async () => {
			const configPath = await writeConfig(tempDir, {
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
				baseline: STANDALONE_BASELINE,
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
			const configPath = await writeConfig(tempDir, {
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
				baseline: STANDALONE_BASELINE,
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
			const configPath = path.join(tempDir, "providers.json");
			await fs.writeFile(configPath, "not valid json{{{");

			const catalog = await loadResolvedProviderCatalog({
				baseline: STANDALONE_BASELINE,
				configPath,
				logger: mockLogger,
			});

			expect(catalog.length).toBe(BUILTIN_PROVIDER_IDS.length); // defaults
			expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to parse"));
		});

		it("should degrade gracefully on schema violation", async () => {
			const configPath = path.join(tempDir, "providers.json");
			await fs.writeFile(configPath, JSON.stringify({ version: 99 }));

			const catalog = await loadResolvedProviderCatalog({
				baseline: STANDALONE_BASELINE,
				configPath,
				logger: mockLogger,
			});

			expect(catalog.length).toBe(BUILTIN_PROVIDER_IDS.length); // defaults
			expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Validation errors"));
		});

		it("should degrade gracefully on a forbidden connection subsection", async () => {
			// `anthropic.aws` is rejected by the tightened per-key schema. The whole
			// user file is invalid and must fall back to defaults, not hard-crash.
			const configPath = path.join(tempDir, "providers.json");
			await fs.writeFile(
				configPath,
				JSON.stringify({ providers: { anthropic: { aws: { region: "us-east-1" } } } }),
			);

			const catalog = await loadResolvedProviderCatalog({
				baseline: STANDALONE_BASELINE,
				configPath,
				logger: mockLogger,
			});

			expect(catalog.length).toBe(BUILTIN_PROVIDER_IDS.length); // defaults
			expect(findProvider(catalog, "anthropic")?.connection.aws).toBeUndefined();
			expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Validation errors"));
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
			const configPath = await writeConfig(tempDir, {
				providers: { openai: { baseUrl: "https://user-openai.example.com" } },
			});

			const catalog = await loadResolvedProviderCatalog({
				baseline: STANDALONE_BASELINE,
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
			const configPath = await writeConfig(tempDir, {
				providers: { anthropic: { baseUrl: "https://user.example.com" } },
			});

			const catalog = await loadResolvedProviderCatalog({
				baseline: STANDALONE_BASELINE,
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
			const configPath = await writeConfig(tempDir, {
				providers: { anthropic: { baseUrl: "https://user.example.com" } },
			});

			const catalog = await loadResolvedProviderCatalog({
				baseline: STANDALONE_BASELINE,
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
			const configPath = await writeConfig(tempDir, { providers: {} });

			const catalog = await loadResolvedProviderCatalog({
				baseline: STANDALONE_BASELINE,
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
			const configPath = await writeConfig(tempDir, { providers: {} });

			const catalog = await loadResolvedProviderCatalog({
				baseline: STANDALONE_BASELINE,
				configPath,
				logger: mockLogger,
				legacyPositronSettings: fakeReader({}),
			});

			expect(catalog.length).toBe(BUILTIN_PROVIDER_IDS.length);
			expect(findProvider(catalog, "anthropic")?.connection.baseUrl).toBeUndefined();
		});
	});
});

// ===========================================================================
// mutateProvidersConfig
// ===========================================================================

describe("mutateProvidersConfig", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-config-mutate-"));
		vi.clearAllMocks();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("should create a new config file from empty", async () => {
		const configPath = path.join(tempDir, "providers.json");

		await mutateProvidersConfig(
			(current) => ({
				...current,
				providers: {
					...current.providers,
					anthropic: { baseUrl: "https://custom.example.com" },
				},
			}),
			{ configPath, logger: mockLogger },
		);

		const raw = JSON.parse(await fs.readFile(configPath, "utf-8"));
		expect(raw.providers.anthropic.baseUrl).toBe("https://custom.example.com");
	});

	it("should preserve existing config when mutating", async () => {
		const configPath = await writeConfig(tempDir, {
			providers: {
				anthropic: { baseUrl: "https://existing.example.com" },
			},
		});

		await mutateProvidersConfig(
			(current) => ({
				...current,
				providers: {
					...current.providers,
					openai: { baseUrl: "https://openai-custom.example.com" },
				},
			}),
			{ configPath, logger: mockLogger },
		);

		const raw = JSON.parse(await fs.readFile(configPath, "utf-8"));
		expect(raw.providers.anthropic.baseUrl).toBe("https://existing.example.com");
		expect(raw.providers.openai.baseUrl).toBe("https://openai-custom.example.com");
	});

	it("preserves values when mutating a commented config", async () => {
		const configPath = path.join(tempDir, "providers.json");
		await fs.writeFile(
			configPath,
			`{
				// Programmatic writes may strip this comment.
				"providers": {
					"anthropic": {
						/* Existing values must survive. */
						"baseUrl": "https://existing.example.com",
					},
				},
			}`,
		);

		await mutateProvidersConfig(
			(current) => ({
				...current,
				providers: {
					...current.providers,
					openai: { enabled: false },
				},
			}),
			{ configPath, logger: mockLogger },
		);

		const written = await fs.readFile(configPath, "utf-8");
		const parsed = JSON.parse(written);
		expect(parsed.providers.anthropic.baseUrl).toBe("https://existing.example.com");
		expect(parsed.providers.openai.enabled).toBe(false);
		expect(written).not.toContain("Programmatic writes");
		expect(written).not.toContain("Existing values");
	});

	it("aborts on syntax-invalid content without changing the file", async () => {
		const configPath = path.join(tempDir, "providers.json");
		const original = '{\n  // unfinished edit\n  "providers": {\n';
		await fs.writeFile(configPath, original);
		const mutator = vi.fn((current: ProvidersConfig) => current);

		const mutation = mutateProvidersConfig(mutator, { configPath, logger: mockLogger });
		await expect(mutation).rejects.toThrow(`Cannot mutate ${configPath}`);
		await expect(mutation).rejects.toThrow("Mutation aborted until the file is fixed");

		expect(mutator).not.toHaveBeenCalled();
		expect(await fs.readFile(configPath, "utf-8")).toBe(original);
	});

	it("aborts on schema-invalid content without changing the file", async () => {
		const configPath = path.join(tempDir, "providers.json");
		const original = '{\n  "version": 99\n}\n';
		await fs.writeFile(configPath, original);
		const mutator = vi.fn((current: ProvidersConfig) => current);

		const mutation = mutateProvidersConfig(mutator, { configPath, logger: mockLogger });
		await expect(mutation).rejects.toThrow(`Cannot mutate ${configPath}`);
		await expect(mutation).rejects.toThrow("Mutation aborted until the file is fixed");

		expect(mutator).not.toHaveBeenCalled();
		expect(await fs.readFile(configPath, "utf-8")).toBe(original);
	});

	it("aborts when the config cannot be read without changing the file", async () => {
		const configPath = await writeConfig(tempDir, {
			providers: { anthropic: { enabled: true } },
		});
		const original = await fs.readFile(configPath, "utf-8");
		const readError = Object.assign(new Error("permission denied"), { code: "EACCES" });
		const readSpy = vi.spyOn(fs, "readFile").mockRejectedValueOnce(readError);
		const mutator = vi.fn((current: ProvidersConfig) => current);

		await expect(
			mutateProvidersConfig(mutator, { configPath, logger: mockLogger }),
		).rejects.toThrow(
			`[ai-config] Cannot mutate ${configPath}: permission denied. Mutation aborted until the file is fixed.`,
		);

		readSpy.mockRestore();
		expect(mutator).not.toHaveBeenCalled();
		expect(await fs.readFile(configPath, "utf-8")).toBe(original);
	});

	it("should reject invalid mutations", async () => {
		const configPath = await writeConfig(tempDir, {});

		await expect(
			mutateProvidersConfig(() => ({ version: 99 }) as unknown as ProvidersConfig, {
				configPath,
				logger: mockLogger,
			}),
		).rejects.toThrow("Mutated config is invalid");
	});

	it("should serialize concurrent mutations", async () => {
		const configPath = await writeConfig(tempDir, {});

		// Run 5 concurrent mutations
		await Promise.all([
			mutateProvidersConfig(
				(c) => ({ ...c, providers: { ...c.providers, anthropic: { enabled: true } } }),
				{ configPath, logger: mockLogger },
			),
			mutateProvidersConfig(
				(c) => ({ ...c, providers: { ...c.providers, openai: { enabled: true } } }),
				{ configPath, logger: mockLogger },
			),
			mutateProvidersConfig(
				(c) => ({ ...c, providers: { ...c.providers, gemini: { enabled: true } } }),
				{ configPath, logger: mockLogger },
			),
			mutateProvidersConfig(
				(c) => ({ ...c, providers: { ...c.providers, bedrock: { enabled: true } } }),
				{ configPath, logger: mockLogger },
			),
			mutateProvidersConfig(
				(c) => ({ ...c, providers: { ...c.providers, deepseek: { enabled: true } } }),
				{ configPath, logger: mockLogger },
			),
		]);

		const raw = JSON.parse(await fs.readFile(configPath, "utf-8"));
		expect(raw.providers.anthropic.enabled).toBe(true);
		expect(raw.providers.openai.enabled).toBe(true);
		expect(raw.providers.gemini.enabled).toBe(true);
		expect(raw.providers.bedrock.enabled).toBe(true);
		expect(raw.providers.deepseek.enabled).toBe(true);
	});

	it("should perform atomic writes (no partial state)", async () => {
		const configPath = await writeConfig(tempDir, {
			providers: { anthropic: { baseUrl: "https://original.example.com" } },
		});

		await mutateProvidersConfig(
			(c) => ({
				...c,
				providers: {
					...c.providers,
					anthropic: { baseUrl: "https://updated.example.com" },
				},
			}),
			{ configPath, logger: mockLogger },
		);

		// No temp files should remain
		const files = await fs.readdir(tempDir);
		expect(files.filter((f) => f.includes(".tmp"))).toHaveLength(0);

		const raw = JSON.parse(await fs.readFile(configPath, "utf-8"));
		expect(raw.providers.anthropic.baseUrl).toBe("https://updated.example.com");
	});
});
