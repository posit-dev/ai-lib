/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * ai-config — Pure Entry
 *
 * Platform-agnostic schema, types, validation, and resolution helpers for
 * ~/.posit/ai/providers.json. No filesystem imports — runs in any JS
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
	SUPPORTED_CUSTOM_CLIENT_KIND_VALUES,
} from "./vocabulary.js";
export type {
	BuiltinProviderId,
	ClientKind,
	Protocol,
	ReservedProviderKey,
	SupportedCustomClientKind,
} from "./vocabulary.js";

// --- Schema ----------------------------------------------------------------
export {
	customModelSchema,
	enforcedProvidersConfigSchema,
	providersConfigSchema,
} from "./schema.js";

// --- Types (inferred + catalog) --------------------------------------------
export {
	mintCustomProviderId,
	MODEL_METADATA_FIELD_NAMES,
	MODEL_ROUTING_FIELD_NAMES,
} from "./types.js";
export type {
	BuiltinProviderBlock,
	CustomModel,
	CustomProviderId,
	CustomProviderEntry,
	DefaultBlock,
	EnforcedProvidersConfig,
	EnforcedProvidersMap,
	LoggerLike,
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
	InferredModelCapabilities,
} from "./types.js";

// --- Model capability inference ---------------------------------------------
export { getAnthropicModelCapabilities } from "./model-capabilities/anthropic-helpers.js";
export { getDeepSeekModelCapabilities } from "./model-capabilities/deepseek-helpers.js";
export { getGeminiModelCapabilities } from "./model-capabilities/gemini-helpers.js";
export { getGemmaModelCapabilities } from "./model-capabilities/gemma-helpers.js";
export {
	getOpenAIModelCapabilities,
	openaiMaxInputTokens,
} from "./model-capabilities/openai-helpers.js";
export { getPositAiModelCapabilities } from "./model-capabilities/positai-helpers.js";
export { inferModelCapabilities } from "./model-capabilities/infer.js";

// --- Defaults --------------------------------------------------------------
export {
	BEDROCK_DEFAULTS,
	GOOGLE_VERTEX_DEFAULTS,
	LMSTUDIO_DEFAULTS,
	OLLAMA_DEFAULTS,
	POSIT_AI_DEFAULTS,
	PROVIDER_CONNECTION_DEFAULTS,
} from "./defaults.js";

// --- Resolution helpers (public) -------------------------------------------
export { resolveModels } from "./resolve-models.js";

// --- Deep resolver seam (owns the precedence stack) ------------------------
export { resolveProviderCatalog } from "./resolve-catalog.js";
export type {
	ProviderConfigSource,
	ProviderConfigSourceKind,
	ResolveProviderCatalogOptions,
} from "./resolve-catalog.js";

// --- Watchable config-source contracts (pure) ------------------------------
// The seam types a host source implements. Kept in the pure entry so
// `ai-config/positron` can build a source without depending on `ai-config/node`.
export type { Disposable, ProviderConfigSourceProvider } from "./config-source.js";

// --- Enforcement merge -----------------------------------------------------
export { mergeConfigFragments, mergeEnforced } from "./enforce.js";
