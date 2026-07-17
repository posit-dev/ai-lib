/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// ai-provider-bridge - Platform-neutral provider infrastructure

// Provider-domain types (owned by this package)
export { NOTIFICATION_ACTIONS, normalizeProtocol, PROVIDER_IDS } from "./types";
export type {
	AiToolWithJsonSchema,
	ApiKeyCredentials,
	AwsCredentials,
	CancellationToken,
	Event,
	GoogleCloudCredentials,
	LegacyProtocol,
	LMStreamPart,
	LocalCredentials,
	Logger,
	ModelInfo,
	NotificationActionId,
	OAuthCredentials,
	PositAiAuthMetadata,
	PositAiModelFetchState,
	Protocol,
	ProviderId,
	ProviderCredentials,
	ResolvedProviderId,
} from "./types";

// Core provider infrastructure
export { NON_IDENTITY_MAPPING, ProviderRegistry } from "./providers/ProviderRegistry";
export type {
	ClientFactory,
	ModelFetcher,
	NonIdentityClientKind,
	NonIdentityFactoryId,
} from "./providers/ProviderRegistry";

// ModelClient interface and shared params type
export type { ModelClient, ModelClientChatParams } from "./model-clients/ModelClient";

// AI SDK types surfaced through the bridge so consumers can use the public API
// without importing `ai` directly: `ModelMessage` appears in ModelClient.chat's
// `messages`, and `LanguageModelUsage` appears on StepLogData.usage. Other `ai`
// types in the public surface are already re-exported as LMStreamPart and
// AiToolWithJsonSchema.
export type { LanguageModelUsage, ModelMessage } from "ai";

// StepLogger interface
export type { StepLogData, StepLogger } from "./StepLogger";

// CredentialProvider interface
export type { CredentialProvider, Disposable } from "./CredentialProvider";

// Cached model fetcher utility
export { createCachedModelFetcher } from "./providers/cached-model-fetcher";
export type {
	CachedModelFetcherConfig,
	ClearableModelFetcher,
} from "./providers/cached-model-fetcher";

// Positron auth-provider mapping (no vscode dependency — pure data)
export { MAPPED_PROVIDER_IDS, PROVIDER_MAP } from "./provider-map";
export type { AuthProviderMapping } from "./provider-map";

// Config-key overrides (authProviderId → VS Code `authentication.<key>` section).
// Re-exported from the pure `credential-shaping` shim (originates in
// ai-credentials/types) so consumers can import it from the bridge ROOT without
// the vscode-coupled `ai-provider-bridge/positron` module.
export { CONFIG_KEY_OVERRIDES } from "./credential-shaping";

// Model capability inference (tables live in ai-config — ai-lib#9; the
// Gemini Interactions API allowlist is bridge routing logic and stays here)
export {
	getAnthropicModelCapabilities,
	getGeminiModelCapabilities,
	getOpenAIModelCapabilities,
	getPositAiModelCapabilities,
	openaiMaxInputTokens,
} from "ai-config";
export {
	getGeminiInteractionsProfile,
	isInteractionsEligible,
} from "./model-capabilities/gemini-interactions";
export type { GeminiInteractionsProfile } from "./model-capabilities/gemini-interactions";

// Tool result image transformation for Chat Completions API compatibility
export {
	hasImagesInToolResults,
	transformToolResultImagesForCompletions,
} from "./tool-result-images";

// Local provider management
export { isLocalProviderId, LOCAL_PROVIDER_IDS, LocalProviderManager } from "./local-providers";
export type { LocalProviderId, LocalProviderManagerOptions } from "./local-providers";

// Bare-host base URL correction (consumed by packages/positron to fix
// incorrect `authentication.*.baseUrl` values at the read seam and on disk)
export { normalizeBaseUrlForProvider } from "./base-url";

// Small utilities
export { isThinkingEnabled } from "./utils";
export { buildSnowflakeCortexUrl } from "./utils";
export { normalizeDatabricksHost } from "./utils";
export { isAgreementRequiredBody } from "./utils";
export { joinPath } from "./utils";

// Provider defaults (single source of truth for gateway URLs)
export { POSIT_AI_DEFAULTS } from "./provider-defaults";
