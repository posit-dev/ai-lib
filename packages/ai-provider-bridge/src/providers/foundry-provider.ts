/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createOpenAICompatibleFetch } from "../model-clients/openai-compat-fetch";
import { OpenAIClient } from "../model-clients/OpenAIClient";
import type { Logger, ModelInfo, ProviderCredentials } from "../types";
import type { ProviderRegistry } from "./ProviderRegistry";

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

export function registerFoundryProvider(registry: ProviderRegistry, logger: Logger): void {
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
		return [FOUNDRY_MODEL];
	};
	fetcher.clearCache = () => {};

	registry.registerModelFetcher("ms-foundry", fetcher);

	registry.registerClientFactory("ms-foundry", (credentials) => {
		if (credentials.type !== "apikey") {
			throw new Error(`Foundry provider requires API key credentials, got: ${credentials.type}`);
		}
		// customHeaders are injected by the custom fetch wrapper.
		return new OpenAIClient(
			credentials.apiKey,
			credentials.baseUrl,
			"completions",
			createOpenAICompatibleFetch("Foundry", credentials.apiKey, credentials.customHeaders),
		);
	});
}
