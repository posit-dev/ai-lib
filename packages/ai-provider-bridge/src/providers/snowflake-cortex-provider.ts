/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { getAnthropicModelCapabilities, getOpenAIModelCapabilities } from "ai-config";

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
		protocol: "anthropic-messages",
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
		protocol: "openai-chat",
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
 *
 * As of 2026-05-15, this is in the docs page referenced above:
 * "Tool calling is supported for OpenAI and Claude models only."
 * This means that all other models are unusable with Posit Assistant.
 *
 */
const SNOWFLAKE_MODELS: ModelInfo[] = [
	// Claude models — Anthropic Messages API protocol
	claudeModel("claude-opus-4-7", "Claude Opus 4.7"),
	claudeModel("claude-sonnet-4-6", "Claude Sonnet 4.6"),
	claudeModel("claude-opus-4-6", "Claude Opus 4.6"),
	claudeModel("claude-haiku-4-5", "Claude Haiku 4.5"),

	// OpenAI models — Chat Completions API protocol
	openaiModel("openai-gpt-5.2", "GPT-5.2", { supportsImages: true }),
	openaiModel("openai-gpt-5.1", "GPT-5.1", { supportsImages: true }),
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
		return new SnowflakeClient(credentials.apiKey, credentials.baseUrl!, credentials.customHeaders);
	});
}
