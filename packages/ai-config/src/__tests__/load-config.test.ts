/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadResolvedProviderCatalog } from "../node/load-catalog";
import { mutateProvidersConfig } from "../node/mutate-config";
import type { ProvidersConfig, ResolvedProvider } from "../types";
import type { PlatformBaseline } from "../types";

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
		vi.unstubAllEnvs();
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	// ========================================================================
	// Basic loading
	// ========================================================================

	describe("basic loading", () => {
		it("should return all built-in providers when file is missing", async () => {
			const catalog = await loadResolvedProviderCatalog({
				baseline: STANDALONE_BASELINE,
				configPath: path.join(tempDir, "nonexistent.json"),
				logger: mockLogger,
			});

			// 14 built-in providers
			expect(catalog.length).toBe(14);
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

			expect(catalog.length).toBe(14);
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

			expect(catalog.length).toBe(14);
			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining("Failed to parse TEST_ENFORCED"),
			);
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
			expect(positai?.connection.oauth?.host).toBe("login.posit.cloud");
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

			// 14 built-ins + 1 custom
			expect(catalog.length).toBe(15);

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

			expect(catalog.length).toBe(14); // defaults
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

			expect(catalog.length).toBe(14); // defaults
			expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Validation errors"));
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
	});

	afterEach(async () => {
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
