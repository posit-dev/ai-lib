/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderCatalogChange } from "../node/types";
import { watchResolvedProviderCatalog } from "../node/watch-catalog";
import type { PlatformBaseline, ProvidersConfig } from "../types";

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

describe("watchResolvedProviderCatalog", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-config-watch-"));
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
		await new Promise((resolve) => setTimeout(resolve, 500));

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

		await new Promise((resolve) => setTimeout(resolve, 500));

		await writeConfig(configPath, {
			providers: { anthropic: { baseUrl: "https://b.example.com" } },
		});

		await new Promise((resolve) => setTimeout(resolve, 600));

		watcher.dispose();

		expect(changes.length).toBeGreaterThanOrEqual(1);
		const lastChange = changes[changes.length - 1];
		expect(lastChange.connectionChanged).toBe(true);
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

		await new Promise((resolve) => setTimeout(resolve, 500));

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

		await new Promise((resolve) => setTimeout(resolve, 500));

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

	it("should include the full catalog in change events", async () => {
		const configPath = path.join(tempDir, "providers.json");
		await writeConfig(configPath, {});

		const changes: ProviderCatalogChange[] = [];
		const watcher = watchResolvedProviderCatalog((change) => changes.push(change), {
			baseline: STANDALONE_BASELINE,
			configPath,
			logger: mockLogger,
		});

		await new Promise((resolve) => setTimeout(resolve, 500));

		// Trigger a change
		await writeConfig(configPath, {
			providers: { anthropic: { enabled: false } },
		});

		await new Promise((resolve) => setTimeout(resolve, 600));

		watcher.dispose();

		if (changes.length > 0) {
			const lastChange = changes[changes.length - 1];
			expect(lastChange.catalog.length).toBe(14); // all built-ins
		}
	});
});
