/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Types specific to the node (filesystem) entry of ai-config.
 */

import type {
	EnforcedProvidersConfig,
	PlatformBaseline,
	ProvidersConfig,
	ResolvedProvider,
} from "../types";

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
	 * Override the config file path (defaults to ~/.posit/genai/providers.json).
	 * Useful for testing.
	 */
	readonly configPath?: string;

	/**
	 * Override the enforced env-var name (defaults to POSIT_GENAI_PROVIDERS_ENFORCED).
	 * Useful for testing.
	 */
	readonly enforcedEnvVar?: string;

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
	 * Environment variables for non-secret connection overlay.
	 * Env vars have highest precedence: env > file > defaults.
	 * Defaults to `process.env` when omitted. Useful for testing.
	 */
	readonly envVars?: Record<string, string | undefined>;
}

/**
 * Options for `mutateProvidersConfig()`.
 */
export interface MutateConfigOptions {
	/**
	 * Override the config file path (defaults to ~/.posit/genai/providers.json).
	 */
	readonly configPath?: string;

	/** Optional logger for diagnostics. */
	readonly logger?: LoggerLike;
}

/**
 * Options for `watchResolvedProviderCatalog()`.
 */
export interface WatchCatalogOptions extends LoadCatalogOptions {
	// Inherits all LoadCatalogOptions fields.
}

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

// ---------------------------------------------------------------------------
// Disposable
// ---------------------------------------------------------------------------

/**
 * A resource that can be disposed.
 */
export interface Disposable {
	dispose(): void;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/**
 * Minimal logger interface for the node entry. Matches the subset actually used.
 */
export interface LoggerLike {
	debug(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Internal: enforced config result
// ---------------------------------------------------------------------------

/**
 * The result of loading and enforcing the providers config.
 * Internal to the catalog builder.
 */
export interface EnforcedConfig {
	/** The user's config as written in the file (validated). */
	readonly userConfig: ProvidersConfig;
	/** The enforced config from the env var (if any). Custom entries have
	 * `type` optional; the merged result is re-validated with the full schema. */
	readonly enforcedConfig: EnforcedProvidersConfig | undefined;
	/** The final merged config (enforced over user). */
	readonly mergedConfig: ProvidersConfig;
}
