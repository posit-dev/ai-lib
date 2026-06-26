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
} from "./types";

/**
 * Resolve the enabled state for a single provider id.
 *
 * Precedence (highest wins):
 * 1. Enforced `providers.<id>.enabled`
 * 2. Enforced `providers.default.enabled`
 * 3. User `providers.<id>.enabled`
 * 4. User `providers.default.enabled`
 * 5. Platform baseline per-provider override
 * 6. Platform baseline `defaultEnabled`
 *
 * The enforced providers map uses a relaxed type where custom entry `type`
 * is optional. Only `enabled` is read here.
 */
export function resolveEnabled(
	providerId: string,
	userProviders: ProvidersMap | undefined,
	enforcedProviders: ProvidersMap | EnforcedProvidersMap | undefined,
	baseline: PlatformBaseline,
): boolean {
	// 1. Enforced per-provider
	const enforcedBlock = getProviderBlock(enforcedProviders, providerId);
	if (enforcedBlock?.enabled !== undefined) {
		return enforcedBlock.enabled;
	}

	// 2. Enforced default
	const enforcedDefault = getDefaultBlock(enforcedProviders);
	if (enforcedDefault?.enabled !== undefined) {
		return enforcedDefault.enabled;
	}

	// 3. User per-provider
	const userBlock = getProviderBlock(userProviders, providerId);
	if (userBlock?.enabled !== undefined) {
		return userBlock.enabled;
	}

	// 4. User default
	const userDefault = getDefaultBlock(userProviders);
	if (userDefault?.enabled !== undefined) {
		return userDefault.enabled;
	}

	// 5. Platform baseline per-provider override
	const baselineOverride = baseline.providerOverrides?.[providerId];
	if (baselineOverride?.enabled !== undefined) {
		return baselineOverride.enabled;
	}

	// 6. Platform baseline default
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
