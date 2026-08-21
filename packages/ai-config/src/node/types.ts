/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Types specific to the node (filesystem) entry of ai-config.
 */

import type { SourcedConfigIssue } from "../config-issue.js";
import type { LegacySettingsReader } from "../legacy-positron-settings/translate.js";
import type { LoggerLike, ResolvedProvider } from "../types.js";

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
	 * PROVIDER-SETTINGS-MIGRATION(legacy-positron): opt in to the user-set
	 * legacy Positron settings channel. Delete when the migration window
	 * closes.
	 *
	 * Presence enables the `legacy-positron` layer only: user-set legacy
	 * settings via this reader, below `user`, above `default`. The
	 * admin-enforced channel is a separate opt-in — see
	 * {@link legacyPositronEnforcedSettings}.
	 *
	 * The layer folds into BOTH the load and watch paths internally — the
	 * watch's initial rebuild does not emit, so a load-path miss would drop
	 * legacy settings until the first change.
	 */
	readonly legacyPositronSettings?: LegacySettingsReader;

	/**
	 * PROVIDER-SETTINGS-MIGRATION(legacy-positron): opt in to the legacy
	 * Workbench admin-enforcement channel. Delete when the migration window
	 * closes.
	 *
	 * `true` enables the `legacy-positron-enforced` layer:
	 * POSITRON_ENFORCED_SETTINGS, read from the loader's `envVars` (default
	 * `process.env`), above `user`, below `enforced`. Unset or `false`
	 * disables it.
	 *
	 * Independent of {@link legacyPositronSettings} so hosts on Positron
	 * versions that migrate settings into providers.json (>= 2026.08) can keep
	 * admin enforcement without the user-settings fallback: with the fallback,
	 * clearing a migrated providers.json value would silently resurrect the
	 * stale legacy setting the migration copied it from.
	 */
	readonly legacyPositronEnforcedSettings?: boolean;
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
 * Inherits the legacy opt-ins (`legacyPositronSettings`,
 * `legacyPositronEnforcedSettings`) from {@link LoadCatalogOptions} so the
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
 * invalidate model caches, `modelsChanged` → refresh model lists,
 * `issuesChanged` → replace displayed configuration diagnostics). Each
 * event also carries the complete current catalog and issue snapshots.
 */
export interface ProviderCatalogChange {
	/** The full new catalog. */
	readonly catalog: readonly ResolvedProvider[];

	/** The complete current issue snapshot, including an empty recovery. */
	readonly issues: readonly SourcedConfigIssue[];

	/** Whether any provider's `enabled` state changed. */
	readonly enabledChanged: boolean;

	/** Whether any provider's connection config changed. */
	readonly connectionChanged: boolean;

	/** Whether any provider's model policy/custom declarations changed. */
	readonly modelsChanged: boolean;

	/** Whether the issue snapshot changed structurally. */
	readonly issuesChanged: boolean;
}
