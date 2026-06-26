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

import { PROVIDER_CONNECTION_DEFAULTS } from "../defaults";
import { resolveEnabled } from "../resolve-enabled";
import type {
	BuiltinProviderBlock,
	CustomProviderEntry,
	EnforcedProvidersMap,
	PlatformBaseline,
	ProvidersConfig,
	ProvidersMap,
	ResolvedConnection,
	ResolvedProvider,
} from "../types";
import { mintCustomProviderId } from "../types";
import { BUILTIN_PROVIDER_IDS } from "../vocabulary";
import type { BuiltinProviderId, ClientKind } from "../vocabulary";

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
 * Build the resolved provider catalog from the (already-enforced) config
 * and the platform baseline.
 *
 * This is the **single deep read seam** (decisions #9/#10) — consumers
 * iterate the result instead of the static registry. Enablement, connection,
 * model policy, and client kind are folded into each `ResolvedProvider`.
 */
export function buildCatalog(
	mergedConfig: ProvidersConfig,
	enforcedProviders: EnforcedProvidersMap | undefined,
	baseline: PlatformBaseline,
): readonly ResolvedProvider[] {
	const providers = mergedConfig.providers;
	const catalog: ResolvedProvider[] = [];

	// 1. Built-in providers
	for (const id of BUILTIN_PROVIDER_IDS) {
		const block = getBuiltinBlock(providers, id);
		const enabled = resolveEnabled(id, providers, enforcedProviders, baseline);
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
	if (customEntries) {
		for (const [name, entry] of Object.entries(customEntries)) {
			const customId = mintCustomProviderId(name);
			const enabled = resolveEnabled(name, providers, enforcedProviders, baseline);
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
		oauth: mergeOptionalSection(defaults.oauth, fromBlock.oauth),
		aws: mergeOptionalSection(defaults.aws, fromBlock.aws),
		googleCloud: mergeOptionalSection(defaults.googleCloud, fromBlock.googleCloud),
		snowflake: mergeOptionalSection(defaults.snowflake, fromBlock.snowflake),
	};
}

/**
 * Extract connection fields from a provider block (built-in or custom).
 */
function resolveConnectionFromBlock(
	block: BuiltinProviderBlock | CustomProviderEntry | undefined,
): ResolvedConnection {
	if (!block) {
		return {};
	}

	return {
		baseUrl: block.baseUrl,
		endpoint: block.endpoint,
		customHeaders: block.customHeaders,
		protocol: block.protocol,
		endpoints: block.endpoints,
		oauth: block.oauth,
		aws: block.aws,
		googleCloud: block.googleCloud,
		snowflake: block.snowflake,
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
