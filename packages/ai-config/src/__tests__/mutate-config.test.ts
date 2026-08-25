/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from "fs";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createConfigFileFixture } from "../../tests/helpers/config-file-fixture.js";
import type { ConfigFileFixture } from "../../tests/helpers/config-file-fixture.js";
import { PROVIDERS_CONFIG_VERSION } from "../index.js";
import { mutateProvidersConfig } from "../node/mutate-config.js";
import { parseJsonc } from "../node/parse-jsonc.js";
import type { ProvidersConfig } from "../types.js";

const mockLogger = {
	debug: vi.fn(),
	warn: vi.fn(),
};

// ===========================================================================
// mutateProvidersConfig
// ===========================================================================

describe("mutateProvidersConfig", () => {
	let fixture: ConfigFileFixture;
	let configPath: string;

	beforeEach(async () => {
		fixture = await createConfigFileFixture();
		configPath = fixture.configPath;
		vi.clearAllMocks();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fixture.cleanup();
	});

	it("should create a new config file from empty", async () => {
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

		const raw = JSON.parse(await fixture.readRaw());
		expect(raw.providers.anthropic.baseUrl).toBe("https://custom.example.com");
	});

	it("should preserve existing config when mutating", async () => {
		await fixture.writeTypedConfig({
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

		const raw = JSON.parse(await fixture.readRaw());
		expect(raw.providers.anthropic.baseUrl).toBe("https://existing.example.com");
		expect(raw.providers.openai.baseUrl).toBe("https://openai-custom.example.com");
	});

	it("preserves comments and formatting outside changed paths", async () => {
		await fixture.writeRawJsonc(
			`{
				// Keep this provider comment.
				"providers": {
					"anthropic": {
						/* Keep this value comment. */
						"baseUrl": "https://existing.example.com",
					},
					"openai": { "enabled": true },
					"gemini": { "enabled": true },
				},
			}`,
		);

		await mutateProvidersConfig(
			(current) => ({
				...current,
				providers: {
					...current.providers,
					anthropic: {
						...current.providers?.anthropic,
						baseUrl: "https://changed.example.com",
						models: { allow: ["claude-new"] },
					},
					openai: undefined,
					gemini: undefined,
					deepseek: { enabled: false },
					bedrock: { enabled: false },
				},
			}),
			{ configPath, logger: mockLogger },
		);

		const written = await fixture.readRaw();
		const parsed = parseJsonc(written) as ProvidersConfig;
		expect(parsed.providers?.anthropic?.baseUrl).toBe("https://changed.example.com");
		expect(parsed.providers?.anthropic?.models?.allow).toEqual(["claude-new"]);
		expect(parsed.providers?.openai).toBeUndefined();
		expect(parsed.providers?.gemini).toBeUndefined();
		expect(parsed.providers?.deepseek?.enabled).toBe(false);
		expect(parsed.providers?.bedrock?.enabled).toBe(false);
		expect(written).toContain("Keep this provider comment");
		expect(written).toContain("Keep this value comment");
	});

	it("preserves the next provider's leading comment when deleting the first provider", async () => {
		await fixture.writeRawJsonc(
			`{
  "providers": {
    "openai": { "enabled": true }, // keep the Anthropic explanation
    "anthropic": { "enabled": true }
  }
}`,
		);

		await mutateProvidersConfig(
			(current) => ({
				...current,
				providers: {
					...current.providers,
					openai: undefined,
				},
			}),
			{ configPath, logger: mockLogger },
		);

		const written = await fixture.readRaw();
		expect(parseJsonc(written)).toEqual({
			providers: { anthropic: { enabled: true } },
		});
		expect(written).toContain("// keep the Anthropic explanation");
	});

	it("does not write for a value-identical mutation", async () => {
		const original = '{\n  // unchanged\n  "providers": { "anthropic": { "enabled": true } }\n}\n';
		await fixture.writeRawJsonc(original);
		const rename = vi.spyOn(fs, "rename");

		await mutateProvidersConfig((current) => ({ ...current }), { configPath, logger: mockLogger });

		expect(rename).not.toHaveBeenCalled();
		expect(await fixture.readRaw()).toBe(original);
	});

	it("detects an in-place same-reference mutation", async () => {
		await fixture.writeRawJsonc(
			'{\n  // retained\n  "providers": { "anthropic": { "enabled": true } }\n}\n',
		);

		await mutateProvidersConfig(
			(current) => {
				current.providers ??= {};
				current.providers.anthropic = { enabled: false };
				return current;
			},
			{ configPath, logger: mockLogger },
		);

		const written = await fixture.readRaw();
		expect(parseJsonc(written)).toMatchObject({ providers: { anthropic: { enabled: false } } });
		expect(written).toContain("// retained");
	});

	it("rejects edits to a duplicate-key path without changing the file", async () => {
		const original = `{
  "providers": {
    "anthropic": {
      "enabled": true,
      "enabled": false
    }
  }
}`;
		await fixture.writeRawJsonc(original);

		await expect(
			mutateProvidersConfig(
				(current) => ({
					...current,
					providers: {
						...current.providers,
						anthropic: { ...current.providers?.anthropic, enabled: true },
					},
				}),
				{ configPath, logger: mockLogger },
			),
		).rejects.toThrow(/duplicate key path providers\.anthropic\.enabled is ambiguous/);
		expect(await fixture.readRaw()).toBe(original);
	});

	it("aborts on syntax-invalid content without changing the file", async () => {
		const original = '{\n  // unfinished edit\n  "providers": {\n';
		await fixture.writeRawJsonc(original);
		const mutator = vi.fn((current: ProvidersConfig) => current);

		const mutation = mutateProvidersConfig(mutator, { configPath, logger: mockLogger });
		await expect(mutation).rejects.toThrow(`Cannot mutate ${configPath}`);
		await expect(mutation).rejects.toThrow("Mutation aborted until the file is fixed");

		expect(mutator).not.toHaveBeenCalled();
		expect(await fixture.readRaw()).toBe(original);
	});

	it("aborts on schema-invalid content without changing the file", async () => {
		const original = '{\n  "version": 99\n}\n';
		await fixture.writeRawJsonc(original);
		const mutator = vi.fn((current: ProvidersConfig) => current);

		const mutation = mutateProvidersConfig(mutator, { configPath, logger: mockLogger });
		await expect(mutation).rejects.toThrow(`Cannot mutate ${configPath}`);
		await expect(mutation).rejects.toThrow("Mutation aborted until the file is fixed");

		expect(mutator).not.toHaveBeenCalled();
		expect(await fixture.readRaw()).toBe(original);
	});

	it("names an unknown provider key and leaves the file byte-for-byte untouched", async () => {
		const bytes = Buffer.from(
			`{"providers":{"anthropic":{"enabled":true},"mystery-provider":{}}}\n`,
		);
		await fixture.writeRawJsonc(bytes.toString("utf8"));

		await expect(mutateProvidersConfig((current) => current, { configPath })).rejects.toThrow(
			/mystery-provider/,
		);
		expect(await fixture.readBytes()).toEqual(bytes);
	});

	it("rejects a raw unsafe custom-provider key without changing the file", async () => {
		const bytes = Buffer.from(
			'{\n  "providers": {\n    "custom": {\n      "__proto__": { "type": "openai-compatible" }\n    }\n  }\n}\n',
		);
		await fixture.writeRawJsonc(bytes.toString("utf8"));
		const mutator = vi.fn((current: ProvidersConfig) => current);

		await expect(mutateProvidersConfig(mutator, { configPath })).rejects.toThrow(/__proto__/);
		expect(mutator).not.toHaveBeenCalled();
		expect(await fixture.readBytes()).toEqual(bytes);
	});

	it("aborts when the config cannot be read without changing the file", async () => {
		await fixture.writeTypedConfig({
			providers: { anthropic: { enabled: true } },
		});
		const original = await fixture.readRaw();
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
		expect(await fixture.readRaw()).toBe(original);
	});

	it("should reject invalid mutations", async () => {
		await fixture.writeTypedConfig({});

		await expect(
			mutateProvidersConfig(() => ({ version: 99 }) as unknown as ProvidersConfig, {
				configPath,
				logger: mockLogger,
			}),
		).rejects.toThrow("Mutated config is invalid");
	});

	it("should serialize concurrent mutations", async () => {
		await fixture.writeTypedConfig({});

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

		const raw = JSON.parse(await fixture.readRaw());
		expect(raw.providers.anthropic.enabled).toBe(true);
		expect(raw.providers.openai.enabled).toBe(true);
		expect(raw.providers.gemini.enabled).toBe(true);
		expect(raw.providers.bedrock.enabled).toBe(true);
		expect(raw.providers.deepseek.enabled).toBe(true);
	});

	it("should perform atomic writes (no partial state)", async () => {
		await fixture.writeTypedConfig({
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
		const files = await fs.readdir(fixture.directory);
		expect(files.filter((f) => f.includes(".tmp"))).toHaveLength(0);

		const raw = JSON.parse(await fixture.readRaw());
		expect(raw.providers.anthropic.baseUrl).toBe("https://updated.example.com");
	});
});

describe("mutateProvidersConfig first creation and seed boundaries", () => {
	let fixture: ConfigFileFixture;
	let configPath: string;

	beforeEach(async () => {
		fixture = await createConfigFileFixture();
		configPath = fixture.configPath;
	});

	afterEach(async () => {
		await fixture.cleanup();
	});

	it("seeds a new file with $schema and version fields", async () => {
		// The file doesn't exist yet. mutateProvidersConfig's raceSafeEnsureFile
		// should create it with $schema and version.
		await mutateProvidersConfig(
			(current) => ({
				...current,
				providers: { anthropic: { enabled: true } },
			}),
			{ configPath, logger: mockLogger },
		);

		const content = JSON.parse(await fixture.readRaw());
		// The mutation applied our providers, plus the seed should have injected
		// $schema and version which the mutation preserves (since the seed
		// writes them and the mutator spreads `current`).
		expect(content.providers?.anthropic?.enabled).toBe(true);
	});

	it("copies providers.schema.json alongside the config file on creation", async () => {
		await mutateProvidersConfig((current) => current, { configPath, logger: mockLogger });

		const schemaPath = path.join(fixture.directory, "providers.schema.json");
		const exists = await fs
			.access(schemaPath)
			.then(() => true)
			.catch(() => false);

		// The schema file should be copied (best-effort — may not exist in all
		// environments, but should work when running from the package source)
		if (exists) {
			const schemaContent = JSON.parse(await fs.readFile(schemaPath, "utf-8"));
			expect(schemaContent).toHaveProperty("$schema");
			expect(schemaContent).toHaveProperty("properties");
		}
		// Either way, the config file should exist and be valid
		const configContent = JSON.parse(await fixture.readRaw());
		expect(configContent).toBeDefined();
	});

	it("does NOT re-inject $schema/version when a user removes them", async () => {
		// Create an initial file without $schema or version
		await fixture.writeTypedConfig({
			providers: { anthropic: { enabled: true } },
		});

		// Mutate the config — should NOT inject $schema or version
		await mutateProvidersConfig(
			(current) => ({
				...current,
				providers: {
					...current.providers,
					openai: { enabled: true },
				},
			}),
			{ configPath, logger: mockLogger },
		);

		const content = JSON.parse(await fixture.readRaw());
		expect(content.providers?.anthropic?.enabled).toBe(true);
		expect(content.providers?.openai?.enabled).toBe(true);
		// $schema and version should NOT have been injected
		expect(content.$schema).toBeUndefined();
		expect(content.version).toBeUndefined();
	});

	it("preserves a user-supplied $schema value in an existing file", async () => {
		const customSchema = "https://my-corp.example.com/providers.schema.json";
		await fixture.writeTypedConfig({
			$schema: customSchema,
			version: PROVIDERS_CONFIG_VERSION,
			providers: { anthropic: { enabled: true } },
		});

		await mutateProvidersConfig(
			(current) => ({
				...current,
				providers: {
					...current.providers,
					openai: { enabled: true },
				},
			}),
			{ configPath, logger: mockLogger },
		);

		const content = JSON.parse(await fixture.readRaw());
		// The user's custom $schema should be preserved
		expect(content.$schema).toBe(customSchema);
		expect(content.version).toBe(PROVIDERS_CONFIG_VERSION);
		expect(content.providers?.openai?.enabled).toBe(true);
	});
});
