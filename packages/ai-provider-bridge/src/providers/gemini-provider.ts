/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025-2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ResolvedProviderId } from "ai-config";
import { GEMINI_API_VERSION, GEMINI_HOST, getGeminiModelCapabilities } from "ai-config";

import { isInteractionsEligible } from "../model-capabilities/gemini-interactions";
import { GeminiClient } from "../model-clients/GeminiClient";
import type { Logger, ModelInfo } from "../types";
import type { ApiKeyCredentials } from "../types";
import { normalizeProviderBaseUrl } from "../utils";
import { createCachedModelFetcher } from "./cached-model-fetcher";
import type { ClientFactory, ProviderRegistry } from "./ProviderRegistry";

/** Default capabilities for unrecognized Gemini models */
const GEMINI_DEFAULT_CAPABILITIES: Partial<ModelInfo> = {
	supportsTools: true,
	supportsImages: true,
	supportsToolResultImages: false,
	supportedInputMediaTypes: [
		"image/png",
		"image/jpeg",
		"image/gif",
		"image/webp",
		"application/pdf",
	],
	maxInputTokens: 1_000_000,
	maxContextLength: 1_000_000,
	maxOutputTokens: 65_536,
};

// Static fallback models — only Interactions-eligible models.
const GEMINI_FALLBACK_ROWS = [
	{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
	{ id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
];

function buildGeminiModel(
	providerId: ResolvedProviderId,
	id: string,
	name: string,
	inputTokenLimit?: number,
	outputTokenLimit?: number,
): ModelInfo {
	const caps = {
		...GEMINI_DEFAULT_CAPABILITIES,
		...getGeminiModelCapabilities(id),
	};

	return {
		id,
		name,
		providerId,
		vendor: "google",
		family: caps.family,
		maxInputTokens: inputTokenLimit ?? caps.maxInputTokens!,
		maxOutputTokens: outputTokenLimit ?? caps.maxOutputTokens!,
		supportsTools: caps.supportsTools!,
		supportsImages: caps.supportsImages!,
		supportedInputMediaTypes: caps.supportedInputMediaTypes,
		supportsToolResultImages: caps.supportsToolResultImages!,
		maxContextLength: inputTokenLimit ?? caps.maxContextLength!,
		thinkingEffortLevels: caps.thinkingEffortLevels,
		supportsWebSearch: false,
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
					.filter((model) => model.name.includes("gemini"))
					.map((model) => {
						const modelId = model.name.replace("models/", "");
						return { ...model, modelId };
					})
					// Fail-closed: only models with an explicit Interactions profile
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
