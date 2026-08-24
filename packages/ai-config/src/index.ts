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
	customProviderEntrySchema,
	providersConfigFragmentSchema,
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
	ProvidersConfigFragment,
	ProvidersMapFragment,
	LoggerLike,
	ModelInfoLike,
	ModelOverride,
	ModelsBlock,
	ProvidersConfig,
	ProvidersMap,
	ResolvedConnection,
	ResolvedConnectionProvenance,
	ResolvedConnectionValueProvenance,
	ResolvedModelInfo,
	ResolvedProvider,
	ResolvedProviderId,
	InferredModelCapabilities,
} from "./types.js";

// --- Model capability inference ---------------------------------------------
export { getAnthropicModelCapabilities } from "./model-capabilities/anthropic-helpers.js";
export { getBedrockMantleModelCapabilities } from "./model-capabilities/bedrock-mantle-helpers.js";
export {
	CONNECT_BEDROCK_MODEL_IDS,
	CONNECT_BEDROCK_MODELS,
	getConnectBedrockModelCapabilities,
} from "./model-capabilities/connect-helpers.js";
export type { ConnectBedrockModelCapabilities } from "./model-capabilities/connect-helpers.js";
export { getDeepSeekModelCapabilities } from "./model-capabilities/deepseek-helpers.js";
export { inferDatabricksModelProfile } from "./model-capabilities/databricks-helpers.js";
export type {
	DatabricksExternalModelInput,
	DatabricksFoundationModelInput,
	DatabricksModelProfile,
	DatabricksModelProfileInput,
	DatabricksNativeProtocol,
	DatabricksServedEntityInput,
	DatabricksSurface,
} from "./model-capabilities/databricks-helpers.js";
export { getGeminiGenerateContentProfile } from "./model-capabilities/gemini-generate-content.js";
export type {
	GeminiGenerateContentProfile,
	GeminiGenerateContentThinking,
} from "./model-capabilities/gemini-generate-content.js";
export { getGeminiModelCapabilities } from "./model-capabilities/gemini-helpers.js";
export { getGemmaModelCapabilities } from "./model-capabilities/gemma-helpers.js";
export {
	classifyLitellmModel,
	getLitellmModelCapabilities,
} from "./model-capabilities/litellm-helpers.js";
export type {
	LitellmModelClassification,
	LitellmModelClassificationInput,
	LitellmModelFamily,
} from "./model-capabilities/litellm-helpers.js";
export {
	getOpenAIModelCapabilities,
	openaiMaxInputTokens,
} from "./model-capabilities/openai-helpers.js";
export {
	classifyPortkeyModel,
	getPortkeyModelCapabilities,
	stripCatalogSlug,
} from "./model-capabilities/portkey-helpers.js";
export type {
	PortkeyModelClassification,
	PortkeyModelClassificationInput,
	PortkeyModelFamily,
} from "./model-capabilities/portkey-helpers.js";
export { getPositAiModelCapabilities } from "./model-capabilities/positai-helpers.js";
export {
	getSnowflakeCortexModelCapabilities,
	SNOWFLAKE_CORTEX_CATALOG,
} from "./model-capabilities/snowflake-cortex-helpers.js";
export type {
	SnowflakeCortexCatalogEntry,
	SnowflakeCortexModelCapabilities,
} from "./model-capabilities/snowflake-cortex-helpers.js";
export { inferLitellmModelProfile, inferModelCapabilities } from "./model-capabilities/infer.js";
export type {
	CompleteInferredModelCapabilities,
	LitellmModelProfile,
	LitellmModelProfileInput,
} from "./model-capabilities/infer.js";

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

// --- Bare-host base URL correction ------------------------------------------
export {
	ANTHROPIC_API_VERSION,
	ANTHROPIC_HOST,
	GEMINI_API_VERSION,
	GEMINI_HOST,
	LMSTUDIO_API_VERSION,
	LMSTUDIO_HOST,
	normalizeBaseUrlForProvider,
	normalizeOpenRouterBaseUrl,
	OPENAI_API_VERSION,
	OPENAI_HOST,
	OPENROUTER_DEFAULT_BASE_URL,
	PORTKEY_API_VERSION,
	PORTKEY_HOST,
	PORTKEY_HOSTED_BASE_URL,
} from "./base-url.js";

// --- Deep resolver seam (owns the precedence stack) ------------------------
export { resolveProviderCatalog, resolveProviderCatalogReport } from "./resolve-catalog.js";
export type {
	ProviderConfigSource,
	ProviderConfigSourceKind,
	ProviderCatalogReport,
	ResolveProviderCatalogOptions,
} from "./resolve-catalog.js";
export type { ConfigIssue, SourcedConfigIssue } from "./config-issue.js";

// --- Tolerant providers.json validation ------------------------------------
export { salvageProvidersConfig } from "./salvage-config.js";

// --- Disposable (returned by LegacySettingsReader.watch) --------------------
export type { Disposable, ProviderConfigSourceReadReport } from "./config-source.js";

// --- Enforcement merge -----------------------------------------------------
export { mergeConfigFragments, mergeEnforced } from "./enforce.js";

// --- PROVIDER-SETTINGS-MIGRATION(legacy-positron) BEGIN ----------------------
// The legacy Positron settings map + translator, shared by the loader's
// legacy layers and Positron's one-shot settings migration. The internal
// source builders are NOT exported — the `legacyPositronSettings` and
// `legacyPositronEnforcedSettings` loader options are the only public
// runtime surface.
export {
	LEGACY_CONNECTION_ROWS,
	legacySettingKeys,
	translateLegacyPositronSettings,
} from "./legacy-positron-settings/index.js";
export type {
	LegacyConnectionRow,
	LegacySettingsReader,
	SettingMigration,
	TranslatedLegacySettings,
} from "./legacy-positron-settings/index.js";
// --- PROVIDER-SETTINGS-MIGRATION(legacy-positron) END ------------------------
