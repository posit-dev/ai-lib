/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createConfigFileFixture } from "../../tests/helpers/config-file-fixture.js";
import type { ConfigFileFixture } from "../../tests/helpers/config-file-fixture.js";
import type { ProviderCatalogChange } from "../node/types.js";
import { watchResolvedProviderCatalog } from "../node/watch-catalog.js";
import { BUILTIN_PROVIDER_IDS } from "../vocabulary.js";

const EVENT_TIMEOUT_MS = 10_000;
const QUIET_WINDOW_MS = 700;

const mockLogger = {
	debug: vi.fn(),
	warn: vi.fn(),
};

function createChangeProbe() {
	const changes: ProviderCatalogChange[] = [];
	const listeners = new Set<(change: ProviderCatalogChange) => void>();

	return {
		changes,
		handler(change: ProviderCatalogChange) {
			changes.push(change);
			for (const listener of [...listeners]) listener(change);
		},
		next(
			predicate: (change: ProviderCatalogChange) => boolean,
			description: string,
		): Promise<ProviderCatalogChange> {
			return new Promise((resolve, reject) => {
				const listener = (change: ProviderCatalogChange) => {
					if (!predicate(change)) return;
					clearTimeout(timer);
					listeners.delete(listener);
					resolve(change);
				};
				const timer = setTimeout(() => {
					listeners.delete(listener);
					reject(new Error(`Timed out waiting for ${description}`));
				}, EVENT_TIMEOUT_MS);
				listeners.add(listener);
			});
		},
		quiet(duration = QUIET_WINDOW_MS): Promise<void> {
			return new Promise((resolve, reject) => {
				const listener = (change: ProviderCatalogChange) => {
					clearTimeout(timer);
					listeners.delete(listener);
					reject(new Error(`Unexpected catalog change: ${JSON.stringify(change)}`));
				};
				const timer = setTimeout(() => {
					listeners.delete(listener);
					resolve();
				}, duration);
				listeners.add(listener);
			});
		},
	};
}

async function awaitReady(watcher: ReturnType<typeof watchResolvedProviderCatalog>): Promise<void> {
	expect(watcher.ready).toBeInstanceOf(Promise);
	await watcher.ready;
}

describe("watchResolvedProviderCatalog", () => {
	let fixture: ConfigFileFixture;
	let configPath: string;

	beforeEach(async () => {
		fixture = await createConfigFileFixture();
		configPath = fixture.configPath;
		vi.clearAllMocks();
	});

	afterEach(async () => {
		await fixture.cleanup();
	});

	it("should fire on enablement change delivered through a real atomic replace", async () => {
		await fixture.writeTypedConfig({
			providers: { anthropic: { enabled: true } },
		});
		const probe = createChangeProbe();
		const watcher = watchResolvedProviderCatalog(probe.handler, { configPath, logger: mockLogger });
		await awaitReady(watcher);

		const changed = probe.next((change) => change.enabledChanged, "enablement change");
		await fixture.writeTypedConfigAtomic({
			providers: { anthropic: { enabled: false } },
		});
		const change = await changed;
		watcher.dispose();

		expect(change.enabledChanged).toBe(true);
		expect(change.catalog.find((provider) => provider.id === "anthropic")?.enabled).toBe(false);
	});

	it("should fire on connection change", async () => {
		await fixture.writeTypedConfig({
			providers: { anthropic: { baseUrl: "https://a.example.com" } },
		});
		const probe = createChangeProbe();
		const watcher = watchResolvedProviderCatalog(probe.handler, { configPath, logger: mockLogger });
		await awaitReady(watcher);

		const changed = probe.next((change) => change.connectionChanged, "connection change");
		await fixture.writeTypedConfigAtomic({
			providers: { anthropic: { baseUrl: "https://b.example.com" } },
		});
		const change = await changed;
		watcher.dispose();

		expect(change.connectionChanged).toBe(true);
	});

	it("should fire when equal-value explicit config changes connection provenance", async () => {
		await fixture.writeTypedConfig({});
		const probe = createChangeProbe();
		const watcher = watchResolvedProviderCatalog(probe.handler, {
			configPath,
			envVars: { AWS_REGION: "us-west-2" },
			logger: mockLogger,
		});
		await awaitReady(watcher);

		const changed = probe.next((change) => change.connectionChanged, "provenance change");
		await fixture.writeTypedConfigAtomic({
			providers: { bedrock: { aws: { region: "us-west-2" } } },
		});
		const change = await changed;
		watcher.dispose();

		expect(change.connectionChanged).toBe(true);
		expect(
			change.catalog.find((provider) => provider.id === "bedrock")?.connectionProvenance,
		).toEqual({ aws: { region: "configuration" } });
	});

	it("should stop firing after dispose", async () => {
		await fixture.writeTypedConfig({});
		const probe = createChangeProbe();
		const watcher = watchResolvedProviderCatalog(probe.handler, { configPath, logger: mockLogger });
		await awaitReady(watcher);

		watcher.dispose();
		const quiet = probe.quiet();
		await fixture.writeTypedConfigAtomic({
			providers: { anthropic: { enabled: false } },
		});
		await quiet;
		expect(probe.changes).toHaveLength(0);
	});

	it("should fire connectionChanged when custom provider type changes", async () => {
		await fixture.writeTypedConfig({
			providers: {
				custom: {
					"my-gateway": {
						type: "openai-compatible",
						baseUrl: "https://gw.example.com",
					},
				},
			},
		});
		const probe = createChangeProbe();
		const watcher = watchResolvedProviderCatalog(probe.handler, { configPath, logger: mockLogger });
		await awaitReady(watcher);

		const changed = probe.next((change) => change.connectionChanged, "custom provider type change");
		await fixture.writeTypedConfigAtomic({
			providers: {
				custom: {
					"my-gateway": {
						type: "anthropic",
						baseUrl: "https://gw.example.com",
					},
				},
			},
		});
		const change = await changed;
		watcher.dispose();

		expect(change.connectionChanged).toBe(true);
	});

	// PROVIDER-SETTINGS-MIGRATION(legacy-positron) gate: delete this test with
	// the loader option.
	it("should rebuild and emit when the legacy Positron reader signals a change", async () => {
		await fixture.writeTypedConfig({});
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
		const probe = createChangeProbe();
		const watcher = watchResolvedProviderCatalog(probe.handler, {
			configPath,
			logger: mockLogger,
			legacyPositronSettings: reader,
		});
		await awaitReady(watcher);

		const changed = probe.next((change) => change.enabledChanged, "legacy settings change");
		legacyValues = { "positron.assistant.provider.anthropic.enable": false };
		fireChange?.();
		const change = await changed;
		watcher.dispose();

		expect(change.catalog.find((provider) => provider.id === "anthropic")?.enabled).toBe(false);
	});

	// PROVIDER-SETTINGS-MIGRATION(legacy-positron) gate: delete this test with
	// the loader option.
	it("should fold the enforced env layer into watch-path rebuilds when legacyPositronEnforcedSettings is set", async () => {
		await fixture.writeTypedConfig({});
		const probe = createChangeProbe();
		const watcher = watchResolvedProviderCatalog(probe.handler, {
			configPath,
			logger: mockLogger,
			envVars: {
				POSITRON_ENFORCED_SETTINGS: JSON.stringify({
					"authentication.anthropic.baseUrl": "https://enforced.example.com",
				}),
			},
			legacyPositronEnforcedSettings: true,
		});
		await awaitReady(watcher);

		const changed = probe.next(
			(change) =>
				change.catalog.find((provider) => provider.id === "openai")?.connection.baseUrl ===
				"https://user-openai.example.com",
			"watch-path rebuild",
		);
		await fixture.writeTypedConfigAtomic({
			providers: { openai: { baseUrl: "https://user-openai.example.com" } },
		});
		const change = await changed;
		watcher.dispose();

		expect(change.catalog.find((provider) => provider.id === "anthropic")?.connection.baseUrl).toBe(
			"https://enforced.example.com",
		);
	});

	it("should include the full catalog in change events", async () => {
		await fixture.writeTypedConfig({});
		const probe = createChangeProbe();
		const watcher = watchResolvedProviderCatalog(probe.handler, { configPath, logger: mockLogger });
		await awaitReady(watcher);

		const changed = probe.next((change) => change.enabledChanged, "full catalog event");
		await fixture.writeTypedConfigAtomic({
			providers: { anthropic: { enabled: false } },
		});
		const change = await changed;
		watcher.dispose();

		expect(change.catalog).toHaveLength(BUILTIN_PROVIDER_IDS.length);
	});

	it("emits and logs issue-only add, repeat, clear, and recurrence transitions", async () => {
		const valid = { providers: { anthropic: { enabled: true } } };
		const invalid = {
			providers: { anthropic: { enabled: true }, "mystery-provider": { enabled: true } },
		};
		await fixture.writeRawJsonc(JSON.stringify(valid));
		const probe = createChangeProbe();
		const watcher = watchResolvedProviderCatalog(probe.handler, { configPath, logger: mockLogger });
		await awaitReady(watcher);

		const added = probe.next((change) => change.issuesChanged, "issue addition");
		await fixture.writeRawJsoncAtomic(JSON.stringify(invalid));
		const addedChange = await added;
		expect(addedChange).toMatchObject({
			enabledChanged: false,
			connectionChanged: false,
			modelsChanged: false,
			issuesChanged: true,
		});
		expect(addedChange.issues).toEqual([
			expect.objectContaining({ path: ["providers", "mystery-provider"] }),
		]);
		const warningsAfterAdd = mockLogger.warn.mock.calls.length;

		const repeatQuiet = probe.quiet();
		await fixture.writeRawJsoncAtomic(JSON.stringify(invalid, null, 2));
		await repeatQuiet;
		expect(probe.changes).toHaveLength(1);
		expect(mockLogger.warn).toHaveBeenCalledTimes(warningsAfterAdd);

		const cleared = probe.next(
			(change) => change.issuesChanged && change.issues.length === 0,
			"issue recovery",
		);
		await fixture.writeRawJsoncAtomic(JSON.stringify(valid));
		const clearedChange = await cleared;
		expect(clearedChange.issues).toEqual([]);

		const recurred = probe.next(
			(change) => change.issuesChanged && change.issues.length > 0,
			"issue recurrence",
		);
		await fixture.writeRawJsoncAtomic(JSON.stringify(invalid));
		const recurredChange = await recurred;
		watcher.dispose();

		expect(recurredChange.issuesChanged).toBe(true);
		expect(probe.changes).toHaveLength(3);
		expect(mockLogger.warn).toHaveBeenCalledTimes(warningsAfterAdd + 1);
	});
});
