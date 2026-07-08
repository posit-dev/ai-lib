/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025-2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { getAnthropicModelCapabilities } from "../model-capabilities/anthropic-helpers";
import {
	ANTHROPIC_API_VERSION,
	ANTHROPIC_HOST,
	AnthropicClient,
} from "../model-clients/AnthropicClient";
import type { Logger, ModelInfo } from "../types";
import type { ApiKeyCredentials } from "../types";
import { normalizeProviderBaseUrl } from "../utils";
import { createCachedModelFetcher } from "./cached-model-fetcher";
import type { ProviderRegistry } from "./ProviderRegistry";

/**
 * Models that are documented and usable but not yet returned by Anthropic's
 * `/v1/models` endpoint. We surface them here so they appear in the selector;
 * each entry is de-duplicated against the live list, so once the endpoint
 * starts returning a model its real `display_name` takes over automatically.
 */
const SUPPLEMENTAL_MODELS: ReadonlyArray<{ id: string; name: string }> = [
	{ id: "claude-fable-5", name: "Claude Fable 5" },
];

/** Build a `ModelInfo` for an Anthropic model, enriched with inferred capabilities. */
function buildAnthropicModel(id: string, name: string): ModelInfo {
	const capabilities = getAnthropicModelCapabilities(id);
	return {
		id,
		name,
		providerId: "anthropic",
		vendor: "anthropic",
		family: undefined,
		maxInputTokens: 200000,
		maxOutputTokens: 16000,
		supportsTools: true,
		supportsImages: true,
		supportsToolResultImages: true,
		supportedInputMediaTypes: [
			"image/png",
			"image/jpeg",
			"image/gif",
			"image/webp",
			"application/pdf",
		],
		maxContextLength: 200000,
		// Spread Anthropic capabilities (family, token limits, thinking effort)
		...capabilities,
		// Direct Anthropic models always support provider-native web search
		supportsWebSearch: true,
	};
}

export function registerAnthropicProvider(registry: ProviderRegistry, logger: Logger): void {
	// Register model fetcher using cached utility
	registry.registerModelFetcher(
		"anthropic",
		createCachedModelFetcher<ApiKeyCredentials>({
			providerId: "anthropic",
			resolveUrl: (credentials) => {
				const base = normalizeProviderBaseUrl(
					credentials.baseUrl,
					ANTHROPIC_HOST,
					ANTHROPIC_API_VERSION,
				);
				return `${base}/models`;
			},
			hasCredentials: (credentials) => Boolean(credentials.apiKey),
			createHeaders: (credentials) => ({
				"x-api-key": credentials.apiKey,
				"anthropic-version": "2023-06-01",
			}),
			parseResponse: (data: unknown) => {
				const typedData = data as { data: Array<{ id: string; display_name: string }> };
				const models = typedData.data.map((model) =>
					buildAnthropicModel(model.id, model.display_name),
				);
				// Append documented models the endpoint doesn't return yet, skipping
				// any that the live list already includes.
				for (const supplemental of SUPPLEMENTAL_MODELS) {
					if (!models.some((model) => model.id === supplemental.id)) {
						models.push(buildAnthropicModel(supplemental.id, supplemental.name));
					}
				}
				return models;
			},
			fallbackModels: [],
			logger,
		}),
	);

	registry.registerClientFactory("anthropic", (credentials) => {
		if (credentials.type !== "apikey") {
			throw new Error(`Anthropic provider requires API key credentials, got: ${credentials.type}`);
		}
		// Pass the raw configured base URL; AnthropicClient.chat() normalizes it
		// (and any per-request routing override) at the single convergence point.
		return new AnthropicClient(credentials.apiKey, credentials.baseUrl, credentials.customHeaders);
	});
}
