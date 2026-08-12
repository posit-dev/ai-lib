/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ResolvedProviderId } from "ai-config";

import { createOpenAICompatibleFetch } from "../model-clients/openai-compat-fetch";
import { OpenAIClient } from "../model-clients/OpenAIClient";
import type { Logger, ModelInfo, ProviderCredentials } from "../types";
import type { ClientFactory, ProviderRegistry } from "./ProviderRegistry";

const FOUNDRY_MODEL: ModelInfo = {
	id: "model-router",
	name: "Model Router",
	providerId: "ms-foundry",
	vendor: "ms-foundry",
	supportsTools: true,
	supportsImages: false,
	supportsToolResultImages: false,
	supportsWebSearch: false,
	maxInputTokens: 128_000,
	maxOutputTokens: 16_384,
	maxContextLength: 128_000,
};

function createFoundryModelFetcher(providerId: ResolvedProviderId, logger: Logger) {
	// Static model fetcher — Foundry uses `model-router` for internal model routing.
	const fetcher = async (credentials: ProviderCredentials): Promise<ModelInfo[]> => {
		if (credentials.type !== "apikey") {
			logger.debug("[Foundry] Wrong credential type, returning empty");
			return [];
		}
		if (!credentials.apiKey || !credentials.baseUrl) {
			logger.debug("[Foundry] Missing apiKey or baseUrl, returning empty");
			return [];
		}
		return [{ ...FOUNDRY_MODEL, providerId }];
	};
	fetcher.clearCache = () => {};

	return fetcher;
}

const foundryClientFactory: ClientFactory = (credentials) => {
	if (credentials.type !== "apikey") {
		throw new Error(`Foundry provider requires API key credentials, got: ${credentials.type}`);
	}
	// customHeaders are injected by the custom fetch wrapper.
	return new OpenAIClient({
		apiKey: credentials.apiKey,
		baseUrl: credentials.baseUrl,
		apiMode: "completions",
		customFetch: createOpenAICompatibleFetch(
			"Foundry",
			credentials.apiKey,
			credentials.customHeaders,
		),
	});
};

export function registerFoundryProvider(registry: ProviderRegistry, logger: Logger): void {
	registry.registerModelFetcher("ms-foundry", createFoundryModelFetcher("ms-foundry", logger));
	registry.registerClientFactory("ms-foundry", foundryClientFactory);
}

export function registerCustomFoundryProvider(
	registry: ProviderRegistry,
	providerId: ResolvedProviderId,
	logger: Logger,
): void {
	registry.registerModelFetcher(providerId, createFoundryModelFetcher(providerId, logger));
	registry.registerClientFactory("ms-foundry", foundryClientFactory);
}
