/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Build a resolved provider catalog from enforced config + platform baseline.
 *
 * Internal to the node entry. The catalog is the deep object that consumers
 * iterate instead of the static PROVIDER_REGISTRY — each entry carries
 * enablement, connection, model policy, and client kind, but NOT discovered
 * models (those need credentials + a runtime fetcher ai-config cannot hold).
 */

import { PROVIDER_CONNECTION_DEFAULTS } from "./defaults.js";
import type { EnablementLayer } from "./resolve-enabled.js";
import { resolveEnabled } from "./resolve-enabled.js";
import type {
	BuiltinProviderBlock,
	CustomProviderEntry,
	PlatformBaseline,
	ProvidersConfig,
	ProvidersMap,
	ResolvedConnection,
	ResolvedProvider,
} from "./types.js";
import { mintCustomProviderId } from "./types.js";
import { BUILTIN_PROVIDER_IDS } from "./vocabulary.js";
import type { BuiltinProviderId, ClientKind } from "./vocabulary.js";

// ---------------------------------------------------------------------------
// Built-in provider id → client kind mapping
// ---------------------------------------------------------------------------

/**
 * Maps each built-in provider id to the bridge `ClientKind` that implements
 * it. Most are identity mappings, but some differ:
 * - `bedrock` → `aws` (the client speaks AWS Bedrock)
 * - `snowflake-cortex` → `snowflake` (the client speaks Snowflake Cortex)
 *
 * The `satisfies` constraint ensures a compile error if a built-in id is
 * added without a corresponding client-kind entry.
 */
const BUILTIN_CLIENT_KIND = {
	positai: "positai",
	anthropic: "anthropic",
	copilot: "copilot",
	openai: "openai",
	bedrock: "aws",
	gemini: "gemini",
	openrouter: "openrouter",
	"google-vertex": "google-vertex",
	ollama: "ollama",
	lmstudio: "lmstudio",
	"openai-compatible": "openai-compatible",
	"snowflake-cortex": "snowflake",
	"ms-foundry": "ms-foundry",
	deepseek: "deepseek",
} as const satisfies Record<BuiltinProviderId, ClientKind>;

/**
 * Build the resolved provider catalog from the merged connection config and
 * an ordered stack of enablement layers.
 *
 * This is the **catalog builder** behind `resolveProviderCatalog` — consumers
 * iterate the result instead of the static registry. Connection, model
 * policy, and client kind are read from `mergedConfig` (the deep-merged
 * result where higher-precedence sources win per key, including connection
 * env vars already folded by the resolver). Enablement is resolved
 * separately from `enabledLayers` (highest precedence first) so the sealed
 * enforced overlay can never be overridden and per-layer "id beats default"
 * semantics are preserved.
 */
export function buildCatalog(
	mergedConfig: ProvidersConfig,
	enabledLayers: readonly EnablementLayer[],
	baseline: PlatformBaseline,
): readonly ResolvedProvider[] {
	const providers = mergedConfig.providers;
	const catalog: ResolvedProvider[] = [];

	// 1. Built-in providers
	for (const id of BUILTIN_PROVIDER_IDS) {
		const block = getBuiltinBlock(providers, id);
		const enabled = resolveEnabled(id, enabledLayers, baseline);
		const connection = resolveConnection(id, block);

		catalog.push({
			id,
			clientKind: BUILTIN_CLIENT_KIND[id],
			enabled,
			connection,
			models: block?.models,
		});
	}

	// 2. Custom providers (from providers.custom map)
	const customEntries = providers?.custom;
	if (customEntries && Object.keys(customEntries).length > 0) {
		for (const [name, entry] of Object.entries(customEntries)) {
			const customId = mintCustomProviderId(name);
			const enabled = resolveEnabled(name, enabledLayers, baseline);
			const connection = resolveConnectionFromBlock(entry);

			catalog.push({
				id: customId,
				clientKind: entry.type,
				enabled,
				connection,
				models: entry.models,
			});
		}
	}

	return catalog;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get a built-in provider block from the providers map.
 */
function getBuiltinBlock(
	providers: ProvidersMap | undefined,
	id: BuiltinProviderId,
): BuiltinProviderBlock | undefined {
	if (!providers) {
		return undefined;
	}
	return (providers as Record<string, unknown>)[id] as BuiltinProviderBlock | undefined;
}

/**
 * Resolve the connection config for a built-in provider. Layering:
 * 1. User/enforced config block fields
 * 2. Built-in defaults (from PROVIDER_CONNECTION_DEFAULTS)
 */
function resolveConnection(
	id: BuiltinProviderId,
	block: BuiltinProviderBlock | undefined,
): ResolvedConnection {
	const defaults = PROVIDER_CONNECTION_DEFAULTS[id];
	const fromBlock = resolveConnectionFromBlock(block);

	if (!defaults) {
		return fromBlock;
	}

	// Layer: block values override defaults
	return {
		baseUrl: fromBlock.baseUrl ?? defaults.baseUrl,
		endpoint: fromBlock.endpoint ?? defaults.endpoint,
		customHeaders: fromBlock.customHeaders ?? defaults.customHeaders,
		protocol: fromBlock.protocol ?? defaults.protocol,
		endpoints: fromBlock.endpoints
			? defaults.endpoints
				? { ...defaults.endpoints, ...fromBlock.endpoints }
				: fromBlock.endpoints
			: defaults.endpoints,
		positaiLogin: mergeOptionalSection(defaults.positaiLogin, fromBlock.positaiLogin),
		aws: mergeOptionalSection(defaults.aws, fromBlock.aws),
		googleCloud: mergeOptionalSection(defaults.googleCloud, fromBlock.googleCloud),
		snowflake: mergeOptionalSection(defaults.snowflake, fromBlock.snowflake),
	};
}

/**
 * Extract connection fields from a provider block (built-in or custom).
 *
 * Reads against the permissive **superset** block type (`BuiltinProviderBlock`,
 * which carries every sub-section optionally). Custom entries are a
 * discriminated union whose variants omit sub-sections that don't apply — but
 * each is structurally assignable to the superset, and a sub-section it lacks
 * simply reads as `undefined`. This lets the reader stay union-agnostic without
 * per-variant narrowing.
 */
function resolveConnectionFromBlock(
	block: BuiltinProviderBlock | CustomProviderEntry | undefined,
): ResolvedConnection {
	if (!block) {
		return {};
	}

	const superset: BuiltinProviderBlock = block;
	return {
		baseUrl: superset.baseUrl,
		endpoint: superset.endpoint,
		customHeaders: superset.customHeaders,
		protocol: superset.protocol,
		endpoints: superset.endpoints,
		positaiLogin: superset.positaiLogin,
		aws: superset.aws,
		googleCloud: superset.googleCloud,
		snowflake: superset.snowflake,
	};
}

/**
 * Merge an optional connection sub-section (oauth, aws, etc.).
 * Block values override defaults on a per-key basis.
 */
function mergeOptionalSection<T extends Record<string, unknown>>(
	defaults: T | undefined,
	block: T | undefined,
): T | undefined {
	if (!block && !defaults) {
		return undefined;
	}
	if (!defaults) {
		return block;
	}
	if (!block) {
		return defaults;
	}
	return { ...defaults, ...block };
}
