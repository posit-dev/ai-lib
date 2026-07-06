/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Types specific to the node (filesystem) entry of ai-config.
 */

import type { ProviderConfigSourceProvider } from "../config-source";
import type { LoggerLike, PlatformBaseline, ResolvedProvider } from "../types";

// Re-export the pure logger type so node consumers can import it from here.
export type { LoggerLike } from "../types";

// Re-export the pure config-source contracts so existing `ai-config/node`
// consumers keep importing them from here (the seam moved to the pure entry so
// `ai-config/positron` can reference it without the node entry — see
// `../config-source`).
export type { Disposable, ProviderConfigSourceProvider } from "../config-source";

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
	 * If true, reject `providers.custom` entries (external builds).
	 *
	 * External builds restrict to the positai provider only and alias
	 * non-positai client code out of the bundle. A runtime `providers.custom`
	 * entry would fail because the client code is aliased away. This flag
	 * causes `buildCatalog` to skip the custom-providers loop and log a
	 * warning if `providers.custom` is non-empty.
	 *
	 * This flag does NOT filter built-in providers — built-in restriction in
	 * external builds is enforced at the bundler aliasing layer.
	 */
	readonly external?: boolean;

	/**
	 * Environment variables for non-secret connection overlay AND for reading
	 * the enforced/default fragment env vars.
	 * Env vars have highest precedence: env > file > defaults.
	 * Defaults to `process.env` when omitted. Useful for testing.
	 */
	readonly envVars?: Record<string, string | undefined>;

	/**
	 * Additional watchable config sources beyond the built-in file + env
	 * sources (e.g. a Positron `authentication.*` host source from
	 * `ai-config/positron`). Any source change — file, host, or otherwise —
	 * rebuilds the catalog and emits a change. Static env sources are read
	 * once per rebuild and need no change signal.
	 *
	 * These are folded into BOTH the load path (`loadResolvedProviderCatalog`
	 * reads each once) and the watch path (`watchResolvedProviderCatalog`
	 * subscribes to each). Threading them through load is load-bearing: the
	 * watch's initial rebuild does not emit, so without a load-path fold the
	 * first catalog would miss host settings until the first change.
	 */
	readonly additionalSources?: readonly ProviderConfigSourceProvider[];
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
 * Inherits `additionalSources` from {@link LoadCatalogOptions} so the same host
 * sources are folded into both the load and watch paths.
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
