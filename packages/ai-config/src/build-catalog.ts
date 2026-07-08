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

import { PROVIDER_CONNECTION_DEFAULTS } from "./defaults";
import type { EnablementLayer } from "./resolve-enabled";
import { resolveEnabled } from "./resolve-enabled";
import type {
	BuiltinProviderBlock,
	CustomProviderEntry,
	PlatformBaseline,
	ProvidersConfig,
	ProvidersMap,
	ResolvedConnection,
	ResolvedProvider,
} from "./types";
import { mintCustomProviderId } from "./types";
import { BUILTIN_PROVIDER_IDS } from "./vocabulary";
import type { BuiltinProviderId, ClientKind } from "./vocabulary";

// ---------------------------------------------------------------------------
// Non-secret connection env var mappings
// ---------------------------------------------------------------------------

/**
 * Maps environment variable names to non-secret connection fields for
 * built-in providers. Env vars have the highest precedence in the
 * connection resolution chain: env > file (providers.json) > defaults.
 *
 * Only non-secret connection config goes here. Secret env vars (API keys,
 * AWS secret keys) are handled by the separate `envCredentialResolver` in
 * `@assistant/node`.
 */
interface ConnectionEnvMapping {
	baseUrl?: string;
	endpoint?: string;
	positaiLogin?: { host?: string; clientId?: string; scope?: string };
	aws?: { region?: string; profile?: string };
	googleCloud?: { project?: string; location?: string };
}

const CONNECTION_ENV_MAPPINGS: Readonly<Record<string, ConnectionEnvMapping>> = {
	anthropic: { baseUrl: "ANTHROPIC_BASE_URL" },
	openai: { baseUrl: "OPENAI_BASE_URL" },
	gemini: { baseUrl: "GEMINI_BASE_URL" },
	positai: {
		baseUrl: "POSITAI_BASE_URL",
		positaiLogin: {
			host: "POSITAI_AUTH_HOST",
			clientId: "POSITAI_CLIENT_ID",
			scope: "POSITAI_SCOPE",
		},
	},
	openrouter: { baseUrl: "OPENROUTER_BASE_URL" },
	ollama: { endpoint: "OLLAMA_ENDPOINT" },
	lmstudio: { endpoint: "LMSTUDIO_ENDPOINT" },
	bedrock: { aws: { region: "AWS_REGION", profile: "AWS_PROFILE" } },
	"google-vertex": {
		googleCloud: {
			project: "GOOGLE_CLOUD_PROJECT",
			location: "GOOGLE_CLOUD_LOCATION",
		},
	},
	"openai-compatible": { baseUrl: "OPENAI_COMPATIBLE_BASE_URL" },
	"ms-foundry": { baseUrl: "MS_FOUNDRY_BASE_URL" },
	"snowflake-cortex": { baseUrl: "SNOWFLAKE_BASE_URL" },
	deepseek: { baseUrl: "DEEPSEEK_BASE_URL" },
};

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
 * result where higher-precedence sources win per key). Enablement is resolved
 * separately from `enabledLayers` (highest precedence first) so the sealed
 * enforced overlay can never be overridden and per-layer "id beats default"
 * semantics are preserved.
 */
export function buildCatalog(
	mergedConfig: ProvidersConfig,
	enabledLayers: readonly EnablementLayer[],
	baseline: PlatformBaseline,
	options?: {
		/**
		 * Environment variables for the non-secret connection overlay. Pure —
		 * defaults to `{}` (no overlay) when omitted, never `process.env`. Node
		 * callers inject `process.env` explicitly.
		 */
		envVars?: Record<string, string | undefined>;
	},
): readonly ResolvedProvider[] {
	const providers = mergedConfig.providers;
	const catalog: ResolvedProvider[] = [];
	// This builder is part of the PURE entry — never reach for `process.env`
	// here (a browser/renderer/notebooks caller may have no `process`). Node
	// callers inject `process.env` via the ai-config/node seams.
	const envVars = options?.envVars ?? {};

	// 1. Built-in providers
	for (const id of BUILTIN_PROVIDER_IDS) {
		const block = getBuiltinBlock(providers, id);
		const enabled = resolveEnabled(id, enabledLayers, baseline);
		const connection = applyEnvOverlay(id, resolveConnection(id, block), envVars);

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

// ---------------------------------------------------------------------------
// Environment variable overlay
// ---------------------------------------------------------------------------

/**
 * Apply non-secret connection env vars on top of the resolved connection.
 * Env vars have the highest precedence: env > file (providers.json) > defaults.
 *
 * Only overrides fields where the corresponding env var is set (non-empty).
 */
function applyEnvOverlay(
	providerId: string,
	connection: ResolvedConnection,
	envVars: Record<string, string | undefined>,
): ResolvedConnection {
	const mapping = CONNECTION_ENV_MAPPINGS[providerId];
	if (!mapping) return connection;

	let result = connection;
	let changed = false;

	// Top-level scalar fields
	if (mapping.baseUrl) {
		const val = envVars[mapping.baseUrl];
		if (val) {
			result = changed ? result : { ...result };
			result.baseUrl = val;
			changed = true;
		}
	}
	if (mapping.endpoint) {
		const val = envVars[mapping.endpoint];
		if (val) {
			result = changed ? result : { ...result };
			result.endpoint = val;
			changed = true;
		}
	}

	// Nested sections — only override fields where the env var is set
	if (mapping.positaiLogin) {
		const overlay = readEnvSection(mapping.positaiLogin, envVars);
		if (overlay) {
			result = changed ? result : { ...result };
			result.positaiLogin = result.positaiLogin ? { ...result.positaiLogin, ...overlay } : overlay;
			changed = true;
		}
	}
	if (mapping.aws) {
		const overlay = readEnvSection(mapping.aws, envVars);
		if (overlay) {
			result = changed ? result : { ...result };
			result.aws = result.aws ? { ...result.aws, ...overlay } : overlay;
			changed = true;
		}
	}
	if (mapping.googleCloud) {
		const overlay = readEnvSection(mapping.googleCloud, envVars);
		if (overlay) {
			result = changed ? result : { ...result };
			result.googleCloud = result.googleCloud ? { ...result.googleCloud, ...overlay } : overlay;
			changed = true;
		}
	}

	return result;
}

/**
 * Read a nested env-mapping section (e.g. `{ host: "ENV_VAR_NAME", ... }`)
 * and return an object with only the fields whose env vars are set.
 * Returns `undefined` if no env vars in the section are set.
 */
function readEnvSection<T extends Record<string, string | undefined>>(
	mapping: T,
	envVars: Record<string, string | undefined>,
): Record<string, string> | undefined {
	let result: Record<string, string> | undefined;
	for (const [field, envVarName] of Object.entries(mapping)) {
		if (!envVarName) continue;
		const val = envVars[envVarName];
		if (val) {
			result ??= {};
			result[field] = val;
		}
	}
	return result;
}
