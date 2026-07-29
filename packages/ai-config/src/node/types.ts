/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Types specific to the node (filesystem) entry of ai-config.
 */

import type { LegacySettingsReader } from "../legacy-positron-settings/translate.js";
import type { LoggerLike, PlatformBaseline, ResolvedProvider } from "../types.js";

// Re-export the pure logger type so node consumers can import it from here.
export type { LoggerLike } from "../types.js";

// Re-export so existing `ai-config/node` consumers keep importing it from here.
export type { Disposable } from "../config-source.js";

// ---------------------------------------------------------------------------
// Load options
// ---------------------------------------------------------------------------

/**
 * Options for `loadResolvedProviderCatalog()`.
 */
export interface LoadCatalogOptions {
	/** Platform baseline (e.g. standalone: all enabled, RStudio: positai only). */
	readonly baseline: PlatformBaseline;

	/**
	 * Override the config file path (defaults to ~/.posit/ai/providers.json).
	 * Useful for testing.
	 */
	readonly configPath?: string;

	/**
	 * Override the enforced env-var name (defaults to POSIT_AI_PROVIDERS_ENFORCED).
	 * Useful for testing.
	 */
	readonly enforcedEnvVar?: string;

	/**
	 * Override the default env-var name (defaults to POSIT_AI_PROVIDERS_DEFAULT).
	 * Useful for testing.
	 */
	readonly defaultEnvVar?: string;

	/** Optional logger for diagnostics and validation warnings. */
	readonly logger?: LoggerLike;

	/**
	 * Environment variables for non-secret connection fields (converted into a
	 * resolver-owned source ranked below `enforced` but above
	 * `user`/`legacy-positron`/`default`) AND for reading the enforced/default
	 * fragment env vars. Defaults to `process.env` when omitted. Useful for
	 * testing.
	 */
	readonly envVars?: Record<string, string | undefined>;

	/**
	 * PROVIDER-SETTINGS-MIGRATION(legacy-positron): opt in to the legacy
	 * Positron settings channels. Delete when the migration window closes.
	 *
	 * Presence enables BOTH legacy layers:
	 * - `legacy-positron-enforced`: POSITRON_ENFORCED_SETTINGS, read from the
	 *   loader's `envVars` (default `process.env`), above `user`, below
	 *   `enforced`.
	 * - `legacy-positron`: user-set legacy settings via this reader, below
	 *   `user`, above `default`.
	 *
	 * Both layers fold into BOTH the load and watch paths internally — the
	 * watch's initial rebuild does not emit, so a load-path miss would drop
	 * legacy settings until the first change.
	 */
	readonly legacyPositronSettings?: LegacySettingsReader;
}

/**
 * Options for `mutateProvidersConfig()`.
 */
export interface MutateConfigOptions {
	/**
	 * Override the config file path (defaults to ~/.posit/ai/providers.json).
	 */
	readonly configPath?: string;

	/** Optional logger for diagnostics. */
	readonly logger?: LoggerLike;
}

/**
 * Options for `watchResolvedProviderCatalog()`.
 *
 * Inherits `legacyPositronSettings` from {@link LoadCatalogOptions} so the
 * same legacy layers are folded into both the load and watch paths.
 */
export type WatchCatalogOptions = LoadCatalogOptions;

// ---------------------------------------------------------------------------
// Watch events
// ---------------------------------------------------------------------------

/**
 * Typed change categories emitted by `watchResolvedProviderCatalog`.
 *
 * Consumers can check these flags to decide which subsystems need updating
 * (e.g. `enabledChanged` → re-register providers, `connectionChanged` →
 * invalidate model caches, `modelsChanged` → refresh model lists).
 */
export interface ProviderCatalogChange {
	/** The full new catalog. */
	readonly catalog: readonly ResolvedProvider[];

	/** Whether any provider's `enabled` state changed. */
	readonly enabledChanged: boolean;

	/** Whether any provider's connection config changed. */
	readonly connectionChanged: boolean;

	/** Whether any provider's model policy/custom declarations changed. */
	readonly modelsChanged: boolean;
}
