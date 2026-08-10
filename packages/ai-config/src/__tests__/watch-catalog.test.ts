/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderCatalogChange } from "../node/types.js";
import { watchResolvedProviderCatalog } from "../node/watch-catalog.js";
import type { PlatformBaseline, ProvidersConfig } from "../types.js";
import { BUILTIN_PROVIDER_IDS } from "../vocabulary.js";

const mockLogger = {
	debug: vi.fn(),
	warn: vi.fn(),
};

const STANDALONE_BASELINE: PlatformBaseline = { defaultEnabled: true };

async function writeConfig(configPath: string, config: ProvidersConfig): Promise<void> {
	const dir = path.dirname(configPath);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

/** Allow the watcher's asynchronous initial snapshot to settle under full-suite load. */
async function waitForInitialSnapshot(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 900));
}

describe("watchResolvedProviderCatalog", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-config-watch-"));
		vi.clearAllMocks();
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("should fire on enablement change", async () => {
		const configPath = path.join(tempDir, "providers.json");
		await writeConfig(configPath, {
			providers: { anthropic: { enabled: true } },
		});

		const changes: ProviderCatalogChange[] = [];
		const watcher = watchResolvedProviderCatalog((change) => changes.push(change), {
			baseline: STANDALONE_BASELINE,
			configPath,
			logger: mockLogger,
		});

		// Wait for initial load
		await waitForInitialSnapshot();

		// Change enablement
		await writeConfig(configPath, {
			providers: { anthropic: { enabled: false } },
		});

		// Wait for debounced change
		await new Promise((resolve) => setTimeout(resolve, 600));

		watcher.dispose();

		expect(changes.length).toBeGreaterThanOrEqual(1);
		const lastChange = changes[changes.length - 1];
		expect(lastChange.enabledChanged).toBe(true);
	});

	it("should fire on connection change", async () => {
		const configPath = path.join(tempDir, "providers.json");
		await writeConfig(configPath, {
			providers: { anthropic: { baseUrl: "https://a.example.com" } },
		});

		const changes: ProviderCatalogChange[] = [];
		const watcher = watchResolvedProviderCatalog((change) => changes.push(change), {
			baseline: STANDALONE_BASELINE,
			configPath,
			logger: mockLogger,
		});

		await waitForInitialSnapshot();

		await writeConfig(configPath, {
			providers: { anthropic: { baseUrl: "https://b.example.com" } },
		});

		await new Promise((resolve) => setTimeout(resolve, 600));

		watcher.dispose();

		expect(changes.length).toBeGreaterThanOrEqual(1);
		const lastChange = changes[changes.length - 1];
		expect(lastChange.connectionChanged).toBe(true);
	});

	it("should fire when equal-value explicit config changes connection provenance", async () => {
		const configPath = path.join(tempDir, "providers.json");
		await writeConfig(configPath, {});

		const changes: ProviderCatalogChange[] = [];
		const watcher = watchResolvedProviderCatalog((change) => changes.push(change), {
			baseline: STANDALONE_BASELINE,
			configPath,
			envVars: { AWS_REGION: "us-west-2" },
			logger: mockLogger,
		});

		await waitForInitialSnapshot();

		await writeConfig(configPath, {
			providers: { bedrock: { aws: { region: "us-west-2" } } },
		});

		await new Promise((resolve) => setTimeout(resolve, 600));
		watcher.dispose();

		expect(changes.length).toBeGreaterThanOrEqual(1);
		const lastChange = changes[changes.length - 1];
		expect(lastChange.connectionChanged).toBe(true);
		expect(
			lastChange.catalog.find((provider) => provider.id === "bedrock")?.connectionProvenance,
		).toEqual({ aws: { region: "configuration" } });
	});

	it("should stop firing after dispose", async () => {
		const configPath = path.join(tempDir, "providers.json");
		await writeConfig(configPath, {});

		const changes: ProviderCatalogChange[] = [];
		const watcher = watchResolvedProviderCatalog((change) => changes.push(change), {
			baseline: STANDALONE_BASELINE,
			configPath,
			logger: mockLogger,
		});

		await waitForInitialSnapshot();

		watcher.dispose();
		const countAfterDispose = changes.length;

		// Modify after dispose
		await writeConfig(configPath, {
			providers: { anthropic: { enabled: false } },
		});

		await new Promise((resolve) => setTimeout(resolve, 600));

		// No new changes should have fired
		expect(changes.length).toBe(countAfterDispose);
	});

	it("should fire connectionChanged when custom provider type changes", async () => {
		const configPath = path.join(tempDir, "providers.json");
		await writeConfig(configPath, {
			providers: {
				custom: {
					"my-gateway": {
						type: "openai-compatible",
						baseUrl: "https://gw.example.com",
					},
				},
			},
		});

		const changes: ProviderCatalogChange[] = [];
		const watcher = watchResolvedProviderCatalog((change) => changes.push(change), {
			baseline: STANDALONE_BASELINE,
			configPath,
			logger: mockLogger,
		});

		await waitForInitialSnapshot();

		// Change the client kind (type) of the custom provider
		await writeConfig(configPath, {
			providers: {
				custom: {
					"my-gateway": {
						type: "anthropic",
						baseUrl: "https://gw.example.com",
					},
				},
			},
		});

		await new Promise((resolve) => setTimeout(resolve, 600));

		watcher.dispose();

		expect(changes.length).toBeGreaterThanOrEqual(1);
		const lastChange = changes[changes.length - 1];
		// A type change is a connection-level change (different client needed)
		expect(lastChange.connectionChanged).toBe(true);
	});

	// PROVIDER-SETTINGS-MIGRATION(legacy-positron) gate: delete this test with
	// the loader option.
	it("should rebuild and emit when the legacy Positron reader signals a change", async () => {
		const configPath = path.join(tempDir, "providers.json");
		await writeConfig(configPath, {});

		// A fake legacy reader. It starts by enabling anthropic through the
		// legacy toggle, then flips to disabling it and fires onChange.
		let legacyValues: Record<string, unknown> = {
			"positron.assistant.provider.anthropic.enable": true,
		};
		let fireChange: (() => void) | undefined;

		const reader = {
			get: (key: string) => legacyValues[key],
			watch: (onChange: () => void) => {
				fireChange = onChange;
				return { dispose: () => {} };
			},
		};

		const changes: ProviderCatalogChange[] = [];
		const watcher = watchResolvedProviderCatalog((change) => changes.push(change), {
			baseline: STANDALONE_BASELINE,
			configPath,
			logger: mockLogger,
			legacyPositronSettings: reader,
		});

		// Wait for the initial load.
		await waitForInitialSnapshot();

		// Change the legacy settings and signal a change. The first emitted
		// catalog after this watch-triggered rebuild must carry the new value —
		// this pins the watch-path fold of the legacy layer.
		legacyValues = { "positron.assistant.provider.anthropic.enable": false };
		fireChange?.();

		await new Promise((resolve) => setTimeout(resolve, 600));

		watcher.dispose();

		expect(changes.length).toBeGreaterThanOrEqual(1);
		const lastChange = changes[changes.length - 1];
		expect(lastChange.enabledChanged).toBe(true);
		expect(lastChange.catalog.find((p) => p.id === "anthropic")?.enabled).toBe(false);
	});

	// PROVIDER-SETTINGS-MIGRATION(legacy-positron) gate: delete this test with
	// the loader option.
	it("should fold the enforced env layer into watch-path rebuilds when legacyPositronEnforcedSettings is set", async () => {
		const configPath = path.join(tempDir, "providers.json");
		await writeConfig(configPath, {});

		const changes: ProviderCatalogChange[] = [];
		const watcher = watchResolvedProviderCatalog((change) => changes.push(change), {
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

		// Wait for the initial load.
		await waitForInitialSnapshot();

		// Trigger a rebuild through an unrelated provider so an event fires;
		// the emitted catalog must still carry the enforced anthropic value —
		// this pins the watch-path fold of the flag-enabled enforced layer.
		await writeConfig(configPath, {
			providers: { openai: { baseUrl: "https://user-openai.example.com" } },
		});

		await new Promise((resolve) => setTimeout(resolve, 600));

		watcher.dispose();

		expect(changes.length).toBeGreaterThanOrEqual(1);
		const lastChange = changes[changes.length - 1];
		expect(lastChange.catalog.find((p) => p.id === "anthropic")?.connection.baseUrl).toBe(
			"https://enforced.example.com",
		);
	});

	it("should include the full catalog in change events", async () => {
		const configPath = path.join(tempDir, "providers.json");
		await writeConfig(configPath, {});

		const changes: ProviderCatalogChange[] = [];
		const watcher = watchResolvedProviderCatalog((change) => changes.push(change), {
			baseline: STANDALONE_BASELINE,
			configPath,
			logger: mockLogger,
		});

		await waitForInitialSnapshot();

		// Trigger a change
		await writeConfig(configPath, {
			providers: { anthropic: { enabled: false } },
		});

		await new Promise((resolve) => setTimeout(resolve, 600));

		watcher.dispose();

		if (changes.length > 0) {
			const lastChange = changes[changes.length - 1];
			expect(lastChange.catalog.length).toBe(BUILTIN_PROVIDER_IDS.length); // all built-ins
		}
	});

	it("emits and logs issue-only add, repeat, clear, and recurrence transitions", async () => {
		const configPath = path.join(tempDir, "providers.json");
		const valid = { providers: { anthropic: { enabled: true } } };
		const invalid = {
			providers: { anthropic: { enabled: true }, portkey: { enabled: true } },
		};
		await fs.writeFile(configPath, JSON.stringify(valid));

		const changes: ProviderCatalogChange[] = [];
		const watcher = watchResolvedProviderCatalog((change) => changes.push(change), {
			baseline: STANDALONE_BASELINE,
			configPath,
			logger: mockLogger,
		});
		await waitForInitialSnapshot();

		await fs.writeFile(configPath, JSON.stringify(invalid));
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({
			enabledChanged: false,
			connectionChanged: false,
			modelsChanged: false,
			issuesChanged: true,
		});
		expect(changes[0].issues).toEqual([
			expect.objectContaining({ path: ["providers", "portkey"] }),
		]);
		const warningsAfterAdd = mockLogger.warn.mock.calls.length;

		await fs.writeFile(configPath, JSON.stringify(invalid, null, 2));
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(changes).toHaveLength(1);
		expect(mockLogger.warn).toHaveBeenCalledTimes(warningsAfterAdd);

		await fs.writeFile(configPath, JSON.stringify(valid));
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(changes).toHaveLength(2);
		expect(changes[1].issuesChanged).toBe(true);
		expect(changes[1].issues).toEqual([]);

		await fs.writeFile(configPath, JSON.stringify(invalid));
		await new Promise((resolve) => setTimeout(resolve, 600));
		watcher.dispose();

		expect(changes).toHaveLength(3);
		expect(changes[2].issuesChanged).toBe(true);
		expect(mockLogger.warn).toHaveBeenCalledTimes(warningsAfterAdd + 1);
	});
});
