/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider entry point
 *
 * Re-exports all provider registration functions and client implementations.
 */

// Provider registration functions
export { registerAnthropicProvider } from "./providers/anthropic-provider";
export { registerCopilotProvider } from "./providers/copilot-provider";
export { registerDeepSeekProvider } from "./providers/deepseek-provider";
export { registerBedrockProvider } from "./providers/bedrock-provider";
export type { BedrockProviderCallbacks } from "./providers/bedrock-provider";
export { registerFoundryProvider } from "./providers/foundry-provider";
export { registerGeminiProvider } from "./providers/gemini-provider";
export { registerGoogleVertexProvider } from "./providers/google-vertex-provider";
export type { GoogleVertexProviderCallbacks } from "./providers/google-vertex-provider";
export { registerLMStudioProvider } from "./providers/lmstudio-provider";
export { registerOllamaProvider } from "./providers/ollama-provider";
export { registerOpenAICompatibleProvider } from "./providers/openai-compatible-provider";
export { registerOpenAIProvider } from "./providers/openai-provider";
export { registerOpenRouterProvider } from "./providers/openrouter-provider";
export { registerPositAiProvider } from "./providers/positai-provider";
export { registerSnowflakeCortexProvider } from "./providers/snowflake-cortex-provider";

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
export {
	getEffectiveLocation,
	GoogleVertexClient,
	isVertexAnthropicModel,
} from "./model-clients/GoogleVertexClient";
export type { GoogleVertexClientConfig } from "./model-clients/GoogleVertexClient";
export { LMStudioClient } from "./model-clients/LMStudioClient";
export { OllamaClient, ollamaThinkParam } from "./model-clients/OllamaClient";
export { OpenAIClient } from "./model-clients/OpenAIClient";
export { OpenRouterClient } from "./model-clients/OpenRouterClient";
export { PositAiClient } from "./model-clients/PositAiClient";
export { SnowflakeClient } from "./model-clients/SnowflakeClient";

// AI SDK helpers
export * from "./model-clients/ai-sdk-helpers";

// OpenAI-compatible fetch wrapper
export { createOpenAICompatibleFetch } from "./model-clients/openai-compat-fetch";
