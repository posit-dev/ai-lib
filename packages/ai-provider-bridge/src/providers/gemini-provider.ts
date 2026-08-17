/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025-2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ResolvedProviderId } from "ai-config";
import { GEMINI_API_VERSION, GEMINI_HOST, inferModelCapabilities } from "ai-config";

import { isInteractionsEligible } from "../model-capabilities/gemini-interactions";
import { GeminiClient } from "../model-clients/GeminiClient";
import type { Logger, ModelInfo } from "../types";
import type { ApiKeyCredentials } from "../types";
import { normalizeProviderBaseUrl } from "../utils";
import { createCachedModelFetcher } from "./cached-model-fetcher";
import type { ClientFactory, ProviderRegistry } from "./ProviderRegistry";

// Static fallback models — only Interactions-eligible models.
const GEMINI_FALLBACK_ROWS = [
	{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
	{ id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
	{ id: "gemma-4-31b-it", name: "Gemma 4 31B IT" },
	{ id: "gemma-4-26b-a4b-it", name: "Gemma 4 26B A4B IT" },
];

function buildGeminiModel(
	providerId: ResolvedProviderId,
	id: string,
	name: string,
	inputTokenLimit?: number,
	outputTokenLimit?: number,
): ModelInfo {
	// ai-config owns capability completion (generic baseline + Gemini-API
	// endpoint inference, including hosted Gemma); the bridge overlays only
	// the token limits from the live /models response.
	const caps = inferModelCapabilities("gemini", id);

	return {
		id,
		name,
		providerId,
		vendor: "google",
		family: caps.family,
		maxInputTokens: inputTokenLimit ?? caps.maxInputTokens,
		maxOutputTokens: outputTokenLimit ?? caps.maxOutputTokens,
		supportsTools: caps.supportsTools,
		supportsImages: caps.supportsImages,
		supportedInputMediaTypes: caps.supportedInputMediaTypes,
		supportsToolResultImages: caps.supportsToolResultImages,
		maxContextLength: inputTokenLimit ?? caps.maxContextLength,
		thinkingEffortLevels: caps.thinkingEffortLevels,
		supportsWebSearch: caps.supportsWebSearch,
	};
}

function createGeminiModelFetcher(
	providerId: ResolvedProviderId,
	includeHostedModels: boolean,
	logger: Logger,
) {
	return createCachedModelFetcher<ApiKeyCredentials>({
		providerId,
		// Google requires API key in query string, not header
		resolveUrl: (credentials) => {
			const base = normalizeProviderBaseUrl(credentials.baseUrl, GEMINI_HOST, GEMINI_API_VERSION);
			const url = new URL("models", base + "/");
			url.searchParams.set("key", credentials.apiKey);
			return url.toString();
		},
		hasCredentials: (credentials) => Boolean(credentials.apiKey),
		createHeaders: () => ({}), // No auth headers needed - key is in URL
		parseResponse: (data) => {
			// Parse Google's model list format
			const typedData = data as {
				models: Array<{
					name: string;
					displayName: string;
					inputTokenLimit?: number;
					outputTokenLimit?: number;
					supportedGenerationMethods?: string[];
				}>;
			};

			return (
				typedData.models
					.map((model) => {
						const modelId = model.name.replace("models/", "");
						return { ...model, modelId };
					})
					// Fail-closed sole gate: only models with an explicit
					// Interactions profile (Gemini and hosted Gemma alike)
					.filter(({ modelId }) => isInteractionsEligible(modelId))
					.map((model) =>
						buildGeminiModel(
							providerId,
							model.modelId,
							model.displayName || model.name,
							model.inputTokenLimit,
							model.outputTokenLimit,
						),
					)
			);
		},
		fallbackModels: includeHostedModels
			? GEMINI_FALLBACK_ROWS.filter(({ id }) => isInteractionsEligible(id)).map(({ id, name }) =>
					buildGeminiModel(providerId, id, name),
				)
			: [],
		logger,
		ttl: 60 * 60 * 1000, // 1 hour (models don't change frequently)
	});
}

function createGeminiClientFactory(logger: Logger): ClientFactory {
	return (credentials) => {
		if (credentials.type !== "apikey") {
			throw new Error(`Gemini provider requires API key, got: ${credentials.type}`);
		}
		return new GeminiClient(
			credentials.apiKey,
			credentials.baseUrl,
			credentials.customHeaders,
			logger,
		);
	};
}

export function registerGeminiProvider(registry: ProviderRegistry, logger: Logger): void {
	registry.registerModelFetcher("gemini", createGeminiModelFetcher("gemini", true, logger));
	registry.registerClientFactory("gemini", createGeminiClientFactory(logger));
}

export function registerCustomGeminiProvider(
	registry: ProviderRegistry,
	providerId: ResolvedProviderId,
	logger: Logger,
): void {
	registry.registerModelFetcher(providerId, createGeminiModelFetcher(providerId, false, logger));
	registry.registerClientFactory("gemini", createGeminiClientFactory(logger));
}
