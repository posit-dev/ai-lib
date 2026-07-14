/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Enforcement merge.
 *
 * Deep-merges an enforced config fragment over user config per decisions #2/#3:
 * - Objects: per-key merge (enforced keys win, user keys preserved).
 * - Arrays: replace (v1 — enforced array replaces user array wholesale).
 * - Primitives: enforced wins.
 */

import type { EnforcedProvidersConfig, ProvidersConfig } from "./types.js";

/**
 * Deep-merge `enforced` over `user`, returning a new config object.
 *
 * Enforced keys are non-overridable — they always win over the same key in
 * user config. User keys not present in enforced are preserved.
 *
 * @param user - The user's config from providers.json (validated).
 * @param enforced - The enforced fragment from POSIT_AI_PROVIDERS_ENFORCED.
 *   Uses `EnforcedProvidersConfig` where custom entry `type` is optional so
 *   admins can enforce individual keys without repeating the full entry.
 * @returns Merged config where enforced keys take precedence.
 */
export function mergeEnforced(
	user: ProvidersConfig,
	enforced: EnforcedProvidersConfig,
): ProvidersConfig {
	return deepMerge(user, enforced) as ProvidersConfig;
}

/**
 * Deep-merge two config fragments, with `override` winning per key.
 *
 * Used by `resolveProviderCatalog` to fold an ordered stack of
 * `ProviderConfigSource`s from lowest → highest precedence into a single
 * merged config. Because the sealed enforced source is applied last (highest
 * precedence), its keys can never be overridden. Object fields (e.g.
 * `customHeaders`) merge per leaf-key; arrays (e.g. `allow`/`deny`) replace
 * wholesale (v1 semantics).
 *
 * Both inputs use the relaxed `EnforcedProvidersConfig` shape so any source
 * may contribute a partial fragment; the merged result is re-validated with
 * the full schema by the caller.
 */
export function mergeConfigFragments(
	base: EnforcedProvidersConfig,
	override: EnforcedProvidersConfig,
): EnforcedProvidersConfig {
	return deepMerge(base, override) as EnforcedProvidersConfig;
}

/**
 * Recursive deep-merge. `override` values take precedence over `base`.
 *
 * Rules:
 * - Plain objects: recurse per key.
 * - Arrays: replace (override wins wholesale).
 * - Primitives / null / undefined: override wins if present.
 */
function deepMerge(base: unknown, override: unknown): unknown {
	// override not provided — keep base
	if (override === undefined) {
		return base;
	}

	// Both are plain objects — recurse
	if (isPlainObject(base) && isPlainObject(override)) {
		const result: Record<string, unknown> = { ...base };
		for (const key of Object.keys(override)) {
			result[key] = deepMerge(base[key], override[key]);
		}
		return result;
	}

	// Arrays, primitives, or type mismatch — override wins
	return override;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
