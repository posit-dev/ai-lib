/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { getGeminiModelCapabilities } from "../model-capabilities/gemini-helpers";
import { GeminiClient } from "../model-clients/GeminiClient";
import type { Logger, ModelInfo } from "../types";
import type { ApiKeyCredentials } from "../types";
import { createCachedModelFetcher } from "./cached-model-fetcher";
import type { ProviderRegistry } from "./ProviderRegistry";

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

// Static fallback models - current as of October 2025
const GEMINI_FALLBACK: ModelInfo[] = [
	{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
	{ id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
].map(({ id, name }) => {
	const caps = {
		...GEMINI_DEFAULT_CAPABILITIES,
		...getGeminiModelCapabilities(id),
	};

	return {
		id,
		name,
		providerId: "gemini",
		vendor: "google",
		family: caps.family,
		maxInputTokens: caps.maxInputTokens!,
		maxOutputTokens: caps.maxOutputTokens!,
		supportsTools: caps.supportsTools!,
		supportsImages: caps.supportsImages!,
		supportedInputMediaTypes: caps.supportedInputMediaTypes,
		supportsToolResultImages: caps.supportsToolResultImages!,
		maxContextLength: caps.maxContextLength!,
		thinkingEffortLevels: caps.thinkingEffortLevels,
		supportsWebSearch: false,
	};
});

export function registerGeminiProvider(registry: ProviderRegistry, logger: Logger): void {
	// Register model fetcher using cached utility
	registry.registerModelFetcher(
		"gemini",
		createCachedModelFetcher<ApiKeyCredentials>({
			providerId: "gemini",
			// Google requires API key in query string, not header
			resolveUrl: (credentials) => {
				const base = (
					credentials.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta"
				).replace(/\/+$/, "");
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

				return typedData.models
					.filter((model) => model.name.includes("gemini"))
					.map((model) => {
						const modelId = model.name.replace("models/", "");
						// Use helper for family, thinkingEffortLevels, and defaults;
						// prefer API-returned token limits when available.
						const caps = {
							...GEMINI_DEFAULT_CAPABILITIES,
							...getGeminiModelCapabilities(modelId),
						};

						return {
							id: modelId,
							name: model.displayName || model.name,
							providerId: "gemini",
							vendor: "google",
							family: caps.family,
							maxInputTokens: model.inputTokenLimit ?? caps.maxInputTokens!,
							maxOutputTokens: model.outputTokenLimit ?? caps.maxOutputTokens!,
							supportsTools: caps.supportsTools!,
							supportsImages: caps.supportsImages!,
							supportedInputMediaTypes: caps.supportedInputMediaTypes,
							supportsToolResultImages: caps.supportsToolResultImages!,
							maxContextLength: model.inputTokenLimit ?? caps.maxContextLength!,
							thinkingEffortLevels: caps.thinkingEffortLevels,
							supportsWebSearch: false,
						};
					});
			},
			fallbackModels: GEMINI_FALLBACK,
			logger,
			ttl: 60 * 60 * 1000, // 1 hour (models don't change frequently)
		}),
	);

	// Register client factory
	registry.registerClientFactory("gemini", (credentials) => {
		if (credentials.type !== "apikey") {
			throw new Error(`Gemini provider requires API key, got: ${credentials.type}`);
		}
		return new GeminiClient(credentials.apiKey, credentials.baseUrl);
	});
}
