/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Custom-provider auth descriptors.
 *
 * Maps `clientKind` string values to auth method metadata, so custom providers
 * (defined in providers.json `custom` section) can resolve credentials without
 * depending on @assistant/*.
 *
 * The map is keyed by plain strings (not the `ClientKind` type from ai-config)
 * to preserve the no-import-edge boundary. A compile-time shape guard in
 * `ai-lib/typechecks/` asserts that the keys cover `CLIENT_KIND_VALUES`.
 *
 * Single source of truth: `CUSTOM_CLIENT_KIND_AUTH_DESCRIPTORS` is a const
 * object keyed by the supported custom client kinds with `satisfies` ensuring
 * every tuple value has a mapping. The Map, Set, and tuple are all derived
 * from it, so adding a kind to the tuple without a descriptor (or vice versa)
 * is a compile error.
 *
 * Moved here from node's ProviderCatalogService so that standalone consumers
 * (Notebooks) can resolve custom-provider credentials without @assistant/*.
 */

/**
 * Auth metadata derived from a custom provider's `clientKind`.
 */
export interface CustomAuthMapping {
	/** Auth method identifier (e.g., "apikey", "oauth", "aws-credentials"). */
	authMethodId: string;
	/** Whether API key is optional (e.g., openai-compatible with baseUrl only). */
	apiKeyOptional: boolean;
}

/**
 * Client kinds supported as custom provider `type` values.
 *
 * Only these client kinds are valid for `providers.custom` entries. Product-
 * specific kinds (positai, anthropic, openai, gemini, copilot) assume built-in
 * registration and specific auth flows; custom providers wanting to proxy
 * those APIs should use `openai-compatible`.
 *
 * Declared as a const tuple so a compile-time shape guard in
 * `ai-lib/typechecks/` can assert the values are a subset of ai-config's
 * `CLIENT_KIND_VALUES`.
 */
export const SUPPORTED_CUSTOM_CLIENT_KIND_VALUES = [
	"openai-compatible",
	"aws",
	"snowflake",
	"google-vertex",
	"ollama",
	"lmstudio",
	"deepseek",
	"openrouter",
	"ms-foundry",
] as const;

/** Union of supported custom client kind string literals. */
type SupportedCustomClientKind = (typeof SUPPORTED_CUSTOM_CLIENT_KIND_VALUES)[number];

/**
 * Authoritative mapping from supported custom client kinds to auth metadata.
 *
 * `satisfies Record<SupportedCustomClientKind, CustomAuthMapping>` ensures
 * every tuple value has an entry and every entry is a valid tuple value —
 * omissions or typos are compile errors.
 */
const CUSTOM_CLIENT_KIND_AUTH_DESCRIPTORS = {
	"openai-compatible": { authMethodId: "apikey", apiKeyOptional: true },
	aws: { authMethodId: "aws-credentials", apiKeyOptional: false },
	snowflake: { authMethodId: "apikey", apiKeyOptional: false },
	"google-vertex": { authMethodId: "google-cloud", apiKeyOptional: false },
	ollama: { authMethodId: "local", apiKeyOptional: false },
	lmstudio: { authMethodId: "local", apiKeyOptional: false },
	deepseek: { authMethodId: "apikey", apiKeyOptional: false },
	openrouter: { authMethodId: "apikey", apiKeyOptional: false },
	"ms-foundry": { authMethodId: "apikey", apiKeyOptional: false },
} as const satisfies Record<SupportedCustomClientKind, CustomAuthMapping>;

/**
 * Map from `clientKind` string values to auth metadata for custom providers.
 * Derived from `CUSTOM_CLIENT_KIND_AUTH_DESCRIPTORS`.
 */
export const CUSTOM_CLIENT_KIND_AUTH_MAP: ReadonlyMap<string, CustomAuthMapping> = new Map(
	Object.entries(CUSTOM_CLIENT_KIND_AUTH_DESCRIPTORS),
);

/**
 * Client kinds supported as custom provider `type` values (as a Set for
 * runtime lookups). Derived from `SUPPORTED_CUSTOM_CLIENT_KIND_VALUES`.
 */
export const SUPPORTED_CUSTOM_CLIENT_KINDS: ReadonlySet<string> = new Set(
	SUPPORTED_CUSTOM_CLIENT_KIND_VALUES,
);
