/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { getAnthropicModelCapabilities } from "../model-capabilities/anthropic-helpers";
import { getOpenAIModelCapabilities } from "../model-capabilities/openai-helpers";
import { SnowflakeClient } from "../model-clients/SnowflakeClient";
import type { Logger, ModelInfo, ProviderCredentials } from "../types";
import type { ProviderRegistry } from "./ProviderRegistry";

const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/**
 * Helper to build a Claude model entry (Anthropic Messages API protocol).
 * All Claude models share the same capabilities on Snowflake Cortex.
 */
function claudeModel(id: string, name: string): ModelInfo {
	const capabilities = getAnthropicModelCapabilities(id);
	return {
		id,
		name,
		providerId: "snowflake-cortex",
		vendor: "snowflake-cortex",
		protocol: "anthropic",
		supportsTools: true,
		supportsImages: true,
		supportsToolResultImages: true,
		supportedInputMediaTypes: [...IMAGE_MEDIA_TYPES],
		supportsWebSearch: false,
		maxInputTokens: 200_000,
		maxOutputTokens: 16_384,
		maxContextLength: 200_000,
		thinkingEffortLevels: capabilities?.thinkingEffortLevels,
	};
}

/**
 * Helper to build an OpenAI Chat Completions model entry.
 */
function openaiModel(
	id: string,
	name: string,
	opts?: { supportsImages?: boolean; maxInputTokens?: number },
): ModelInfo {
	const supportsImages = opts?.supportsImages ?? false;
	// Strip "openai-" prefix to match against standard OpenAI model IDs
	const standardId = id.replace(/^openai-/, "");
	const capabilities = getOpenAIModelCapabilities(standardId);
	return {
		id,
		name,
		providerId: "snowflake-cortex",
		vendor: "snowflake-cortex",
		protocol: "openai",
		supportsTools: true,
		supportsImages,
		supportsToolResultImages: false,
		supportedInputMediaTypes: supportsImages ? [...IMAGE_MEDIA_TYPES] : undefined,
		supportsWebSearch: false,
		maxInputTokens: opts?.maxInputTokens ?? 128_000,
		maxOutputTokens: 16_384,
		maxContextLength: opts?.maxInputTokens ?? 128_000,
		thinkingEffortLevels: capabilities?.thinkingEffortLevels,
	};
}

/**
 * Full Snowflake Cortex REST API model catalog.
 * Source: https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-rest-api
 *
 * Claude models support both the Messages API (anthropic protocol) and
 * Chat Completions API. We route them through the Messages API for
 * better feature support (thinking, tool use, images in tool results).
 * All other models use Chat Completions only.
 */
const SNOWFLAKE_MODELS: ModelInfo[] = [
	// Claude models — Anthropic Messages API protocol
	claudeModel("claude-sonnet-4-6", "Claude Sonnet 4.6"),
	claudeModel("claude-opus-4-6", "Claude Opus 4.6"),
	claudeModel("claude-sonnet-4-5", "Claude Sonnet 4.5"),
	claudeModel("claude-opus-4-5", "Claude Opus 4.5"),
	claudeModel("claude-haiku-4-5", "Claude Haiku 4.5"),
	claudeModel("claude-4-sonnet", "Claude Sonnet 4"),
	claudeModel("claude-4-opus", "Claude Opus 4"),
	claudeModel("claude-3-7-sonnet", "Claude 3.7 Sonnet"),

	// OpenAI models — Chat Completions API protocol
	openaiModel("openai-gpt-5.2", "GPT-5.2", { supportsImages: true }),
	openaiModel("openai-gpt-5.1", "GPT-5.1", { supportsImages: true }),
	openaiModel("openai-gpt-5", "GPT-5", { supportsImages: true }),
	openaiModel("openai-gpt-5-mini", "GPT-5 Mini", { supportsImages: true }),
	openaiModel("openai-gpt-5-nano", "GPT-5 Nano", { supportsImages: true }),
	openaiModel("openai-gpt-4.1", "GPT-4.1", { supportsImages: true }),
	openaiModel("openai-gpt-oss-120b", "GPT OSS 120B"),

	// Meta Llama models — Chat Completions API protocol
	openaiModel("llama4-maverick", "Llama 4 Maverick", { supportsImages: true }),
	openaiModel("llama3.1-8b", "Llama 3.1 8B"),
	openaiModel("llama3.1-70b", "Llama 3.1 70B"),
	openaiModel("llama3.1-405b", "Llama 3.1 405B"),
	openaiModel("snowflake-llama-3.3-70b", "Snowflake Llama 3.3 70B"),

	// Other models — Chat Completions API protocol
	openaiModel("deepseek-r1", "DeepSeek R1"),
	openaiModel("mistral-7b", "Mistral 7B", { maxInputTokens: 32_000 }),
	openaiModel("mistral-large", "Mistral Large"),
	openaiModel("mistral-large2", "Mistral Large 2"),
];

export function registerSnowflakeCortexProvider(registry: ProviderRegistry, logger: Logger): void {
	// Static model fetcher — Snowflake Cortex serves a known set of models.
	const fetcher = async (credentials: ProviderCredentials): Promise<ModelInfo[]> => {
		if (credentials.type !== "apikey") {
			logger.debug("[Snowflake] Wrong credential type, returning empty");
			return [];
		}
		// baseUrl is the real gate — it's constructed from SNOWFLAKE_ACCOUNT.
		if (!credentials.baseUrl) {
			logger.debug("[Snowflake] Missing baseUrl (no SNOWFLAKE_ACCOUNT), returning empty");
			return [];
		}
		return SNOWFLAKE_MODELS;
	};
	fetcher.clearCache = () => {};

	registry.registerModelFetcher("snowflake-cortex", fetcher);

	registry.registerClientFactory("snowflake-cortex", (credentials) => {
		if (credentials.type !== "apikey") {
			throw new Error(`Snowflake provider requires API key credentials, got: ${credentials.type}`);
		}
		return new SnowflakeClient(credentials.apiKey, credentials.baseUrl!);
	});
}
