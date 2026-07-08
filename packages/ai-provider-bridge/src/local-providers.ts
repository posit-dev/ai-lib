/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Local provider helper module for Ollama and LM Studio.
 *
 * Defines provider IDs and the LocalProviderManager class that manages
 * endpoint configuration via dependency injection. No platform-specific or
 * vscode dependencies -- callers inject I/O.
 *
 * Local providers do NOT go through PROVIDER_MAP or MAPPED_PROVIDER_IDS —
 * those are strictly for VS Code auth-based providers.
 *
 * Endpoints are stored in `~/.positai/settings.json` under a `providers` key
 * and cached in-memory for synchronous reads. A file watcher keeps the cache
 * in sync with external edits.
 */

import type { Disposable } from "./CredentialProvider";

export type { Disposable };

export const LOCAL_PROVIDER_IDS = ["ollama", "lmstudio"] as const;

/** Narrow type prevents accidental calls like getEndpoint("anthropic"). */
export type LocalProviderId = (typeof LOCAL_PROVIDER_IDS)[number];

const LOCAL_PROVIDER_ID_SET: ReadonlySet<string> = new Set(LOCAL_PROVIDER_IDS);

export function isLocalProviderId(providerId: string): providerId is LocalProviderId {
	return LOCAL_PROVIDER_ID_SET.has(providerId);
}

/**
 * Canonical default endpoints for local providers.
 *
 * Ollama is the bare server root — its client uses the native API and appends
 * `/api/...` paths itself. LM Studio follows the OpenAI-compatible convention:
 * the endpoint includes the `/v1` version segment (a bare default host is
 * normalized for backward compatibility).
 */
export const LOCAL_PROVIDER_DEFAULT_ENDPOINTS: Record<LocalProviderId, string> = {
	ollama: "http://localhost:11434",
	lmstudio: "http://localhost:1234/v1",
};

// ============================================================================
// Dependency Injection Interface
// ============================================================================

export interface LocalProviderManagerOptions {
	/**
	 * Read and parse the settings file.
	 * Return the parsed object, or undefined if the file doesn't exist.
	 * Throw on parse/permission errors (manager will catch and preserve cache).
	 */
	readSettings(): Promise<Record<string, unknown> | undefined>;

	/**
	 * Atomically read-mutate-write the settings file.
	 * Create the file if it doesn't exist.
	 */
	mutateSettings(mutator: (config: Record<string, unknown>) => void): Promise<void>;

	/** Watch the settings file for changes. Returns a disposable to stop watching. */
	watchSettings(onChange: () => void): Disposable;

	/** Check if local providers feature is enabled. */
	isEnabled(): boolean;

	/** Watch for feature-gate changes. Returns a disposable to stop watching. */
	watchEnabled(onChange: () => void): Disposable;

	logger: { warn(msg: string): void; info(msg: string): void };
}

// ============================================================================
// LocalProviderManager
// ============================================================================

export class LocalProviderManager {
	private readonly options: LocalProviderManagerOptions;
	private readonly endpointCache = new Map<LocalProviderId, string>();
	private readonly changeCallbacks = new Set<(providerIds: LocalProviderId[]) => void>();
	private settingsWatcher: Disposable | null = null;
	private enabledWatcher: Disposable | null = null;

	constructor(options: LocalProviderManagerOptions) {
		this.options = options;
	}

	/**
	 * Read disk + start file watcher and feature-gate watcher.
	 * Must be called before getEndpoint()/setEndpoint()/clearEndpoint().
	 */
	async initialize(): Promise<void> {
		await this.reloadLocalProviderEndpoints();

		this.settingsWatcher = this.options.watchSettings(() => {
			void this.reloadLocalProviderEndpoints().then((changed) => {
				if (changed.length > 0) {
					this.fireChange(changed);
				}
			});
		});

		this.enabledWatcher = this.options.watchEnabled(() => {
			this.fireChange([...LOCAL_PROVIDER_IDS]);
		});
	}

	/**
	 * Read the endpoint for a local provider from the in-memory cache.
	 * Returns undefined if no endpoint is set.
	 */
	getEndpoint(providerId: LocalProviderId): string | undefined {
		return this.endpointCache.get(providerId);
	}

	/**
	 * Write the endpoint to settings.json and update the cache.
	 */
	async setEndpoint(providerId: LocalProviderId, endpoint: string): Promise<void> {
		await this.options.mutateSettings((config) => {
			// Normalize: if providers or providers[id] aren't plain objects, replace them.
			if (typeof config.providers !== "object" || config.providers === null) {
				config.providers = {};
			}
			const providers = config.providers as Record<string, unknown>;
			if (typeof providers[providerId] !== "object" || providers[providerId] === null) {
				providers[providerId] = {};
			}
			(providers[providerId] as Record<string, unknown>).endpoint = endpoint;
		});

		if (this.updateEndpointCache(providerId, endpoint)) {
			this.fireChange([providerId]);
		}
	}

	/**
	 * Clear the endpoint from settings.json, pruning empty objects.
	 */
	async clearEndpoint(providerId: LocalProviderId): Promise<void> {
		await this.options.mutateSettings((config) => {
			const providers = config.providers as Record<string, Record<string, unknown>> | undefined;
			if (!providers?.[providerId]) return;

			delete providers[providerId].endpoint;

			if (Object.keys(providers[providerId]).length === 0) {
				delete providers[providerId];
			}
			if (Object.keys(providers).length === 0) {
				delete config.providers;
			}
		});

		if (this.updateEndpointCache(providerId, undefined)) {
			this.fireChange([providerId]);
		}
	}

	/** Check if local providers feature is enabled. */
	isEnabled(): boolean {
		return this.options.isEnabled();
	}

	/**
	 * Subscribe to changes in endpoint configuration or the feature gate.
	 * The callback receives the affected provider IDs.
	 */
	onDidChange(callback: (providerIds: LocalProviderId[]) => void): Disposable {
		this.changeCallbacks.add(callback);
		return {
			dispose: () => {
				this.changeCallbacks.delete(callback);
			},
		};
	}

	/**
	 * Re-evaluate the feature gate and fire a change event for all local
	 * provider IDs. Call this when the gate value may have changed via a
	 * path that `watchEnabled` does not cover (e.g. settings.json edits).
	 */
	recheckEnabled(): void {
		this.fireChange([...LOCAL_PROVIDER_IDS]);
	}

	/** Stop watchers and clear change callbacks. */
	dispose(): void {
		this.settingsWatcher?.dispose();
		this.enabledWatcher?.dispose();
		this.settingsWatcher = null;
		this.enabledWatcher = null;
		this.changeCallbacks.clear();
	}

	// ============================================================================
	// Internal helpers
	// ============================================================================

	/**
	 * Re-read settings and update the endpoint cache.
	 * Returns the list of provider IDs whose endpoints changed.
	 */
	private async reloadLocalProviderEndpoints(): Promise<LocalProviderId[]> {
		let providers: Record<string, unknown> | undefined;

		try {
			const parsed = await this.options.readSettings();
			if (parsed === undefined) {
				// File absent — treat as empty config
				providers = {};
			} else {
				const raw = parsed.providers;
				providers =
					typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : undefined;
			}
		} catch (err) {
			// Parse error / permission error — preserve last good cache
			this.options.logger.warn(
				`[LocalProviderManager] Failed to read settings: ${err instanceof Error ? err.message : String(err)}`,
			);
			return [];
		}

		const changed: LocalProviderId[] = [];
		for (const id of LOCAL_PROVIDER_IDS) {
			const providerEntry = providers?.[id];
			const raw =
				typeof providerEntry === "object" && providerEntry !== null
					? (providerEntry as Record<string, unknown>).endpoint
					: undefined;
			const endpoint = typeof raw === "string" && raw ? raw : undefined;
			if (this.updateEndpointCache(id, endpoint)) {
				changed.push(id);
			}
		}
		return changed;
	}

	/**
	 * Update or delete a single cache entry. Returns true if the value changed.
	 */
	private updateEndpointCache(providerId: LocalProviderId, endpoint: string | undefined): boolean {
		const prev = this.endpointCache.get(providerId);
		if (endpoint) {
			if (prev === endpoint) return false;
			this.endpointCache.set(providerId, endpoint);
			return true;
		} else {
			if (prev === undefined) return false;
			this.endpointCache.delete(providerId);
			return true;
		}
	}

	private fireChange(providerIds: LocalProviderId[]): void {
		for (const cb of this.changeCallbacks) {
			cb(providerIds);
		}
	}
}
