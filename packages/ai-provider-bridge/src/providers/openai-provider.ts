/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025-2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import {
	getOpenAIModelCapabilities,
	openaiMaxInputTokens,
} from "../model-capabilities/openai-helpers";
import { OPENAI_API_VERSION, OPENAI_HOST, OpenAIClient } from "../model-clients/OpenAIClient";
import type { Logger, ModelInfo } from "../types";
import type { ApiKeyCredentials } from "../types";
import { normalizeProviderBaseUrl } from "../utils";
import { createCachedModelFetcher } from "./cached-model-fetcher";
import { getOpenAIModelName } from "./openai-model-names";
import type { ProviderRegistry } from "./ProviderRegistry";

/** Default capabilities for unrecognized OpenAI models (GPT-3.5, unknown) */
const OPENAI_DEFAULT_CAPABILITIES = {
	supportsTools: true,
	supportsImages: false,
	supportsToolResultImages: false,
	maxContextLength: 128000,
	maxOutputTokens: 16384,
};

// Static fallback models for Responses API - current as of March 2026
// Only includes models confirmed to support Responses API
const OPENAI_FALLBACK: ModelInfo[] = [
	{ id: "gpt-5.4", name: "GPT-5.4" },
	{ id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
	{ id: "gpt-5.4-nano", name: "GPT-5.4 Nano" },
	{ id: "gpt-5.4-pro", name: "GPT-5.4 Pro" },
	{ id: "gpt-5-chat-latest", name: "GPT-5 Chat Latest" },
].map(({ id, name }) => {
	const caps = {
		...OPENAI_DEFAULT_CAPABILITIES,
		...getOpenAIModelCapabilities(id),
	};

	return {
		id,
		name,
		providerId: "openai",
		vendor: "openai",
		family: caps.family,
		maxInputTokens: openaiMaxInputTokens(caps),
		maxOutputTokens: caps.maxOutputTokens,
		supportsTools: caps.supportsTools,
		supportsImages: caps.supportsImages,
		supportedInputMediaTypes: caps.supportedInputMediaTypes,
		supportsToolResultImages: caps.supportsToolResultImages,
		maxContextLength: caps.maxContextLength,
		thinkingEffortLevels: caps.thinkingEffortLevels,
		supportsWebSearch: false,
	};
});

export function registerOpenAIProvider(registry: ProviderRegistry, logger: Logger): void {
	// Register model fetcher using cached utility
	registry.registerModelFetcher(
		"openai",
		createCachedModelFetcher<ApiKeyCredentials>({
			providerId: "openai",
			resolveUrl: (credentials) => {
				const base = normalizeProviderBaseUrl(credentials.baseUrl, OPENAI_HOST, OPENAI_API_VERSION);
				return `${base}/models`;
			},
			hasCredentials: (credentials) => Boolean(credentials.apiKey),
			createHeaders: (credentials) => ({
				Authorization: `Bearer ${credentials.apiKey}`,
			}),
			parseResponse: (data) => {
				const typedData = data as {
					data: Array<{ id: string; object: string; owned_by: string }>;
				};
				// Filter to GPT models only (skip embeddings, audio, etc.)
				const chatModels = typedData.data.filter(
					(model) =>
						(model.id.startsWith("gpt-5") ||
							model.id.startsWith("gpt-4") ||
							model.id.startsWith("o")) &&
						!model.id.includes("instruct"), // Exclude legacy instruct models
				);

				return chatModels.map((model) => {
					const caps = {
						...OPENAI_DEFAULT_CAPABILITIES,
						...getOpenAIModelCapabilities(model.id),
					};

					// Open AI models have a shared context window, we must reserve space for output tokens
					const maxInputTokens = openaiMaxInputTokens(caps);

					return {
						id: model.id,
						name: getOpenAIModelName(model.id),
						providerId: "openai",
						vendor: "openai",
						family: caps.family,
						maxInputTokens,
						maxOutputTokens: caps.maxOutputTokens,
						// Capabilities from helper function
						supportsTools: caps.supportsTools,
						supportsImages: caps.supportsImages,
						supportedInputMediaTypes: caps.supportedInputMediaTypes,
						supportsToolResultImages: caps.supportsToolResultImages,
						maxContextLength: caps.maxContextLength,
						thinkingEffortLevels: caps.thinkingEffortLevels,
						supportsWebSearch: false,
					};
				});
			},
			fallbackModels: OPENAI_FALLBACK,
			logger,
		}),
	);

	// Register client factory
	registry.registerClientFactory("openai", (credentials) => {
		if (credentials.type !== "apikey") {
			throw new Error(`OpenAI provider requires API key credentials, got: ${credentials.type}`);
		}
		return new OpenAIClient(
			credentials.apiKey,
			credentials.baseUrl,
			"responses",
			undefined,
			credentials.customHeaders,
		);
	});
}
