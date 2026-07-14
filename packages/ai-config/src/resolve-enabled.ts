/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider enablement resolution.
 *
 * Internal to the catalog builder — not part of the public API surface.
 * Consumers read enabled-ness off each `ResolvedProvider` in the catalog.
 */

import type {
	BuiltinProviderBlock,
	DefaultBlock,
	EnforcedProvidersMap,
	PlatformBaseline,
	ProvidersMap,
} from "./types.js";

/** A single enablement layer — a providers map from one config source. */
export type EnablementLayer = ProvidersMap | EnforcedProvidersMap | undefined;

/**
 * Resolve the enabled state for a single provider id across an ordered stack
 * of config layers.
 *
 * `layers` is ordered **highest precedence first**. Within each layer the
 * per-provider block wins over that layer's `default` block. The first layer
 * (top-down) that defines an `enabled` value for this provider (directly or
 * via `default`) wins — a "first defined wins" precedence reduction. Because
 * the sealed enforced overlay is the top layer, it can never be overridden.
 *
 * The canonical layer order assembled by `resolveProviderCatalog`:
 * 1. ENFORCED  (sealed — always wins)
 * 2. user      (providers.json)
 * 3. host      (Positron authentication.*, transitional)
 * 4. DEFAULT   (Workbench admin defaults)
 * then the platform baseline:
 * 5. baseline per-provider override
 * 6. baseline `defaultEnabled`
 *
 * Enforced/default layers use a relaxed providers map where custom entry
 * `type` is optional. Only `enabled` is read here.
 */
export function resolveEnabled(
	providerId: string,
	layers: readonly EnablementLayer[],
	baseline: PlatformBaseline,
): boolean {
	for (const layer of layers) {
		// Per-provider block wins over the layer's default block.
		const block = getProviderBlock(layer, providerId);
		if (block?.enabled !== undefined) {
			return block.enabled;
		}
		const layerDefault = getDefaultBlock(layer);
		if (layerDefault?.enabled !== undefined) {
			return layerDefault.enabled;
		}
	}

	// Platform baseline per-provider override.
	const baselineOverride = baseline.providerOverrides?.[providerId];
	if (baselineOverride?.enabled !== undefined) {
		return baselineOverride.enabled;
	}

	// Platform baseline default.
	return baseline.defaultEnabled;
}

/**
 * Get a provider block from the providers map. Works for both built-in ids
 * (direct keys) and custom ids (under `providers.custom`).
 *
 * Accepts both full and enforced (relaxed `type`) maps since only `enabled`
 * is read from the result.
 */
function getProviderBlock(
	providers: ProvidersMap | EnforcedProvidersMap | undefined,
	providerId: string,
): BuiltinProviderBlock | { enabled?: boolean } | undefined {
	if (!providers) {
		return undefined;
	}

	// Check built-in keys first
	const builtinBlock = (providers as Record<string, unknown>)[providerId];
	if (
		builtinBlock &&
		typeof builtinBlock === "object" &&
		providerId !== "default" &&
		providerId !== "custom"
	) {
		return builtinBlock as BuiltinProviderBlock;
	}

	// Check custom providers
	return providers.custom?.[providerId];
}

function getDefaultBlock(
	providers: ProvidersMap | EnforcedProvidersMap | undefined,
): DefaultBlock | undefined {
	return providers?.default;
}
