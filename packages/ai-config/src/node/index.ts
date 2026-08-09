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
 * - `loadProviderCatalogReport(opts)` — the **canonical deep read seam**.
 *   Folds enablement + connection + model policy + client kind into a
 *   uniform `ResolvedProvider[]` and returns the complete current issue
 *   snapshot. `loadResolvedProviderCatalog(opts)` remains as the historical
 *   bare-catalog compatibility wrapper.
 *
 * ### Write seam
 * - `mutateProvidersConfig(mutator)` — cross-process-safe mutation.
 *
 * ### Watch seam
 * - `watchResolvedProviderCatalog(handler, opts)` — the **single watch seam**.
 *   Emits the resolved catalog and complete issue snapshot with typed change
 *   flags (enabled / connection / models / issues).
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
export * from "../index.js";

// --- Paths -----------------------------------------------------------------
export { AI_CONFIG_DIR, PROVIDERS_CONFIG_PATH } from "./paths.js";

// --- Read seam (canonical report + bare-catalog compatibility wrapper) -----
export { loadProviderCatalogReport, loadResolvedProviderCatalog } from "./load-catalog.js";
export type { LoadedProviderCatalogReport } from "./load-catalog.js";

// --- Source-assembly compatibility seam (file + env → sources) -----------
// Canonical host reads use `loadProviderCatalogReport`; `loadConfigSources`
// retains the historical bare-source contract. Raw file/env readers stay
// internal so callers can't recreate source-assembly or fallback policy.
export { loadConfigSources } from "./load-config.js";
export type { LoadConfigSourcesOptions } from "./load-config.js";

// --- Write seam ------------------------------------------------------------
export { mutateProvidersConfig } from "./mutate-config.js";

// --- Watch seam (the single, source-aware watch seam) ----------------------
export { watchResolvedProviderCatalog } from "./watch-catalog.js";

// --- Types -----------------------------------------------------------------
export type {
	Disposable,
	LoadCatalogOptions,
	LoggerLike,
	MutateConfigOptions,
	ProviderCatalogChange,
	WatchCatalogOptions,
} from "./types.js";
