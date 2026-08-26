/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider entry point
 *
 * Re-exports all provider registration functions and client implementations.
 */

// Provider registration functions
export {
	registerAnthropicProvider,
	registerCustomAnthropicProvider,
} from "./providers/anthropic-provider";
export {
	fetchConnectIntegrations,
	registerConnectProvider,
	shapeConnectIntegrations,
} from "./providers/connect-provider";
export type {
	ConnectAwsCredentialResult,
	ConnectIntegration,
	ConnectProviderCallbacks,
} from "./providers/connect-provider";
export { registerCopilotProvider } from "./providers/copilot-provider";
export { registerDatabricksProvider } from "./providers/databricks-provider";
export {
	registerCustomDeepSeekProvider,
	registerDeepSeekProvider,
} from "./providers/deepseek-provider";
export {
	registerBedrockProvider,
	registerCustomBedrockProvider,
} from "./providers/bedrock-provider";
export type { BedrockProviderCallbacks } from "./providers/bedrock-provider";
export {
	registerCustomFoundryProvider,
	registerFoundryProvider,
} from "./providers/foundry-provider";
export { registerCustomGeminiProvider, registerGeminiProvider } from "./providers/gemini-provider";
export {
	registerCustomGoogleVertexProvider,
	registerGoogleVertexProvider,
} from "./providers/google-vertex-provider";
export type { GoogleVertexProviderCallbacks } from "./providers/google-vertex-provider";
export {
	registerCustomLitellmProvider,
	registerLitellmProvider,
} from "./providers/litellm-provider";
export {
	registerCustomLMStudioProvider,
	registerLMStudioProvider,
} from "./providers/lmstudio-provider";
export { registerCustomOllamaProvider, registerOllamaProvider } from "./providers/ollama-provider";
export {
	registerCustomOpenAICompatibleProvider,
	registerOpenAICompatibleProvider,
} from "./providers/openai-compatible-provider";
export { registerCustomOpenAIProvider, registerOpenAIProvider } from "./providers/openai-provider";
export {
	registerCustomOpenRouterProvider,
	registerOpenRouterProvider,
} from "./providers/openrouter-provider";
export {
	registerCustomPortkeyProvider,
	registerPortkeyProvider,
	resolvePortkeyConnection,
} from "./providers/portkey-provider";
export type { PortkeyConnection } from "./providers/portkey-provider";
export { registerPositAiProvider } from "./providers/positai-provider";
export {
	registerCustomSnowflakeProvider,
	registerSnowflakeCortexProvider,
} from "./providers/snowflake-cortex-provider";
export type { SnowflakeProviderCallbacks } from "./providers/snowflake-cortex-provider";

// Provider registration orchestrator
export { registerAllProviders } from "./register-all-providers";
export type { ProviderRegistrationConfig } from "./register-all-providers";

// Bedrock SSO utilities
export { isAwsSsoProfileConfigured, parseAwsConfig } from "./providers/bedrock-sso";

// Google Vertex display-name and model-classification helpers
export {
	claudeDisplayName,
	geminiDisplayName,
	stripResourcePrefix,
} from "./providers/google-vertex-provider";

// Ollama thinking-level helpers
export { getOllamaThinkingLevels } from "./providers/ollama-provider";

// OpenAI model-name mapping
export { getOpenAIModelName } from "./providers/openai-model-names";

// Provider endpoint testing
export {
	testLMStudioProvider,
	testLocalProvider,
	testOllamaProvider,
	testOpenAICompatibleProvider,
} from "./providers/provider-test";

// Client implementations
export { AnthropicClient } from "./model-clients/AnthropicClient";
export type { AnthropicClientAuth } from "./model-clients/AnthropicClient";
export { DeepSeekClient } from "./model-clients/DeepSeekClient";
export { CopilotSdkClient } from "./model-clients/CopilotSdkClient";
export { BedrockClient, isAnthropicModel } from "./model-clients/BedrockClient";
export type { BedrockClientConfig } from "./model-clients/BedrockClient";
export { GeminiClient } from "./model-clients/GeminiClient";
export {
	buildInteractionsOptions,
	extractPreviousInteractionId,
	filterUnsignedReasoning,
} from "./model-clients/GeminiClient";
export { GeminiGenerateContentClient } from "./model-clients/GeminiGenerateContentClient";
export type { GeminiGenerateContentAuth } from "./model-clients/GeminiGenerateContentClient";
export {
	getEffectiveLocation,
	GoogleVertexClient,
	isVertexAnthropicModel,
} from "./model-clients/GoogleVertexClient";
export type { GoogleVertexClientConfig } from "./model-clients/GoogleVertexClient";
export { LMStudioClient } from "./model-clients/LMStudioClient";
export { OllamaClient, ollamaThinkParam } from "./model-clients/OllamaClient";
export { OpenAIClient } from "./model-clients/OpenAIClient";
export type { OpenAIApiMode, OpenAIClientConfig } from "./model-clients/OpenAIClient";
export { OpenRouterClient } from "./model-clients/OpenRouterClient";
export { PositAiClient } from "./model-clients/PositAiClient";
export { SnowflakeClient, type SnowflakeAuthScheme } from "./model-clients/SnowflakeClient";

// AI SDK helpers
export * from "./model-clients/ai-sdk-helpers";

// OpenAI-compatible fetch wrapper
export { createOpenAICompatibleFetch } from "./model-clients/openai-compat-fetch";
