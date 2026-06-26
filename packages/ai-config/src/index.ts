/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * ai-config — Pure Entry
 *
 * Platform-agnostic schema, types, validation, and resolution helpers for
 * ~/.posit/genai/providers.json. No filesystem imports — runs in any JS
 * environment (browser, Node, test).
 *
 * The ./node entry (ai-config/node) adds filesystem I/O: load, watch, write.
 */

// --- On-disk config version ------------------------------------------------
/** On-disk config file version. */
export const PROVIDERS_CONFIG_VERSION = 1;

// --- Vocabulary ------------------------------------------------------------
export {
	BUILTIN_PROVIDER_IDS,
	CLIENT_KIND_VALUES,
	isBuiltinProviderId,
	PROTOCOL_VALUES,
	RESERVED_PROVIDER_KEYS,
} from "./vocabulary";
export type { BuiltinProviderId, ClientKind, Protocol, ReservedProviderKey } from "./vocabulary";

// --- Schema ----------------------------------------------------------------
export { enforcedProvidersConfigSchema, providersConfigSchema } from "./schema";

// --- Types (inferred + catalog) --------------------------------------------
export {
	mintCustomProviderId,
	MODEL_METADATA_FIELD_NAMES,
	MODEL_ROUTING_FIELD_NAMES,
} from "./types";
export type {
	BuiltinProviderBlock,
	CustomModel,
	CustomProviderId,
	CustomProviderEntry,
	DefaultBlock,
	EnforcedProvidersConfig,
	EnforcedProvidersMap,
	ModelInfoLike,
	ModelOverride,
	ModelsBlock,
	PlatformBaseline,
	ProvidersConfig,
	ProvidersMap,
	ResolvedConnection,
	ResolvedModelInfo,
	ResolvedProvider,
	ResolvedProviderId,
} from "./types";

// --- Defaults --------------------------------------------------------------
export {
	BEDROCK_DEFAULTS,
	GOOGLE_VERTEX_DEFAULTS,
	LMSTUDIO_DEFAULTS,
	OLLAMA_DEFAULTS,
	POSIT_AI_DEFAULTS,
	PROVIDER_CONNECTION_DEFAULTS,
} from "./defaults";

// --- Resolution helpers (public) -------------------------------------------
export { resolveModels } from "./resolve-models";

// --- Enforcement merge -----------------------------------------------------
export { mergeEnforced } from "./enforce";
