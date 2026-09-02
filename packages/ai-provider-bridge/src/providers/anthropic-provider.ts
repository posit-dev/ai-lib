/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025-2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ResolvedProviderId } from "ai-config";
import { ANTHROPIC_API_VERSION, ANTHROPIC_HOST, getAnthropicModelCapabilities } from "ai-config";

import { AnthropicClient } from "../model-clients/AnthropicClient";
import type { Logger, ModelInfo } from "../types";
import type { ApiKeyCredentials } from "../types";
import { normalizeProviderBaseUrl } from "../utils";
import { createCachedModelFetcher } from "./cached-model-fetcher";
import type { ClientFactory, ProviderRegistry } from "./ProviderRegistry";

/**
 * Models that are documented and usable but not yet returned by Anthropic's
 * `/v1/models` endpoint. We surface them here so they appear in the selector;
 * each entry is de-duplicated against the live list, so once the endpoint
 * starts returning a model its real `display_name` takes over automatically.
 */
const SUPPLEMENTAL_MODELS: ReadonlyArray<{ id: string; name: string }> = [
	// { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
];

/** Build a `ModelInfo` for an Anthropic model, enriched with inferred capabilities. */
function buildAnthropicModel(providerId: ResolvedProviderId, id: string, name: string): ModelInfo {
	const capabilities = getAnthropicModelCapabilities(id);
	return {
		id,
		name,
		providerId,
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

function createAnthropicModelFetcher(
	providerId: ResolvedProviderId,
	includeHostedModels: boolean,
	logger: Logger,
) {
	return createCachedModelFetcher<ApiKeyCredentials>({
		providerId,
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
				buildAnthropicModel(providerId, model.id, model.display_name),
			);
			// Append documented models the endpoint doesn't return yet, skipping
			// any that the live list already includes.
			if (includeHostedModels) {
				for (const supplemental of SUPPLEMENTAL_MODELS) {
					if (!models.some((model) => model.id === supplemental.id)) {
						models.push(buildAnthropicModel(providerId, supplemental.id, supplemental.name));
					}
				}
			}
			return models;
		},
		fallbackModels: [],
		logger,
	});
}

function createAnthropicClientFactory(logger: Logger): ClientFactory {
	return (credentials) => {
		if (credentials.type !== "apikey") {
			throw new Error(`Anthropic provider requires API key credentials, got: ${credentials.type}`);
		}
		return new AnthropicClient(
			{ apiKey: credentials.apiKey },
			credentials.baseUrl,
			credentials.customHeaders,
			logger,
		);
	};
}

export function registerAnthropicProvider(registry: ProviderRegistry, logger: Logger): void {
	registry.registerModelFetcher(
		"anthropic",
		createAnthropicModelFetcher("anthropic", true, logger),
	);
	registry.registerClientFactory("anthropic", createAnthropicClientFactory(logger));
}

export function registerCustomAnthropicProvider(
	registry: ProviderRegistry,
	providerId: ResolvedProviderId,
	logger: Logger,
): void {
	registry.registerModelFetcher(providerId, createAnthropicModelFetcher(providerId, false, logger));
	registry.registerClientFactory("anthropic", createAnthropicClientFactory(logger));
}
