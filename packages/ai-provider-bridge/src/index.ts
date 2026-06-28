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

// Model capability inference
export { getAnthropicModelCapabilities } from "./model-capabilities/anthropic-helpers";
export {
	getGeminiModelCapabilities,
	getGeminiInteractionsProfile,
	isInteractionsEligible,
} from "./model-capabilities/gemini-helpers";
export type { GeminiInteractionsProfile } from "./model-capabilities/gemini-helpers";
export {
	getOpenAIModelCapabilities,
	openaiMaxInputTokens,
} from "./model-capabilities/openai-helpers";
export { getPositAiModelCapabilities } from "./model-capabilities/positai-helpers";

// Tool result image transformation for Chat Completions API compatibility
export {
	hasImagesInToolResults,
	transformToolResultImagesForCompletions,
} from "./tool-result-images";

// Local provider management
export { isLocalProviderId, LOCAL_PROVIDER_IDS, LocalProviderManager } from "./local-providers";
export type { LocalProviderId, LocalProviderManagerOptions } from "./local-providers";

// Small utilities
export { isThinkingEnabled } from "./utils";
export { buildSnowflakeCortexUrl } from "./utils";
export { isAgreementRequiredBody } from "./utils";
export { joinPath } from "./utils";

// Provider defaults (single source of truth for gateway URLs)
export { POSIT_AI_DEFAULTS } from "./provider-defaults";
