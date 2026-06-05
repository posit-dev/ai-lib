/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025-2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { getAnthropicModelCapabilities } from "../model-capabilities/anthropic-helpers";
import { AnthropicClient } from "../model-clients/AnthropicClient";
import type { Logger } from "../types";
import type { ApiKeyCredentials } from "../types";
import { normalizeConfiguredBaseUrl, normalizeProviderBaseUrl } from "../utils";
import { createCachedModelFetcher } from "./cached-model-fetcher";
import type { ProviderRegistry } from "./ProviderRegistry";

/** Anthropic public API host. `@ai-sdk/anthropic` expects baseURL to include `/v1`. */
const ANTHROPIC_HOST = "https://api.anthropic.com";

export function registerAnthropicProvider(registry: ProviderRegistry, logger: Logger): void {
	// Register model fetcher using cached utility
	registry.registerModelFetcher(
		"anthropic",
		createCachedModelFetcher<ApiKeyCredentials>({
			providerId: "anthropic",
			resolveUrl: (credentials) => {
				const base = normalizeProviderBaseUrl(credentials.baseUrl, ANTHROPIC_HOST, "v1");
				return `${base}/models`;
			},
			hasCredentials: (credentials) => Boolean(credentials.apiKey),
			createHeaders: (credentials) => ({
				"x-api-key": credentials.apiKey,
				"anthropic-version": "2023-06-01",
			}),
			parseResponse: (data: unknown) => {
				const typedData = data as { data: Array<{ id: string; display_name: string }> };
				return typedData.data.map((model) => {
					const capabilities = getAnthropicModelCapabilities(model.id);
					return {
						id: model.id,
						name: model.display_name,
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
				});
			},
			fallbackModels: [],
			logger,
		}),
	);

	registry.registerClientFactory("anthropic", (credentials) => {
		if (credentials.type !== "apikey") {
			throw new Error(`Anthropic provider requires API key credentials, got: ${credentials.type}`);
		}
		return new AnthropicClient(
			credentials.apiKey,
			normalizeConfiguredBaseUrl(credentials.baseUrl, ANTHROPIC_HOST, "v1"),
			credentials.customHeaders,
		);
	});
}
