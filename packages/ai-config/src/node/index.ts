/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * ai-config/node — Filesystem Entry
 *
 * Load, watch, and write ~/.posit/ai/providers.json with cross-process
 * locking, atomic writes, and typed change events. Imports the pure entry
 * for schema/validation; adds Node-specific I/O.
 *
 * Re-exports everything from the pure entry so consumers that need both
 * the types and the I/O can import from a single specifier.
 *
 * ## Public API surface (narrow — deep module principle)
 *
 * ### Read seam
 * - `loadResolvedProviderCatalog(opts)` — the **single deep read seam**.
 *   Folds enablement + connection + model policy + client kind into a
 *   uniform `ResolvedProvider[]` that consumers iterate instead of the
 *   static `PROVIDER_REGISTRY`.
 *
 * ### Write seam
 * - `mutateProvidersConfig(mutator)` — cross-process-safe mutation.
 *
 * ### Watch seam
 * - `watchResolvedProviderCatalog(handler, opts)` — the **single watch seam**.
 *   Emits typed change events (enabled / connection / models) over the
 *   resolved catalog.
 *
 * ### Model resolution
 * - `resolveModels(...)` — stays public because it genuinely needs
 *   runtime-discovered models the catalog cannot hold.
 *
 * ### Paths
 * - `PROVIDERS_CONFIG_PATH`, `AI_CONFIG_DIR` — centralized for one-edit
 *   changes.
 */

// Re-export everything from the pure entry
export * from "../index";

// --- Paths -----------------------------------------------------------------
export { AI_CONFIG_DIR, PROVIDERS_CONFIG_PATH } from "./paths";

// --- Read seam (the single deep read seam) ---------------------------------
export { loadResolvedProviderCatalog } from "./load-catalog";

// --- Source assembly (file + env fragments → ProviderConfigSource[]) -------
// The deep seam is `loadConfigSources` + `resolveProviderCatalog`; the raw
// file/env readers stay internal so callers can't recreate source-assembly or
// fallback policy outside ai-config.
export { loadConfigSources } from "./load-config";
export type { LoadConfigSourcesOptions } from "./load-config";

// --- Write seam ------------------------------------------------------------
export { mutateProvidersConfig } from "./mutate-config";

// --- Watch seam (the single, source-aware watch seam) ----------------------
export { watchResolvedProviderCatalog } from "./watch-catalog";

// --- Types -----------------------------------------------------------------
export type {
	Disposable,
	LoadCatalogOptions,
	LoggerLike,
	MutateConfigOptions,
	ProviderCatalogChange,
	ProviderConfigSourceProvider,
	WatchCatalogOptions,
} from "./types";
