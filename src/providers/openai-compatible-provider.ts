/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createOpenAICompatibleFetch } from "../model-clients/openai-compat-fetch";
import { OpenAIClient } from "../model-clients/OpenAIClient";
import type { Logger, ModelInfo } from "../types";
import type { ApiKeyCredentials } from "../types";
import { createCachedModelFetcher } from "./cached-model-fetcher";
import type { ProviderRegistry } from "./ProviderRegistry";

/** Conservative defaults for models from unknown endpoints */
const OPENAI_COMPATIBLE_DEFAULTS = {
	vendor: "openai-compatible" as const,
	supportsTools: true,
	supportsImages: false,
	supportsToolResultImages: false,
	supportsWebSearch: false,
	maxInputTokens: 128_000,
	maxOutputTokens: 16_384,
	maxContextLength: 128_000,
} satisfies Partial<ModelInfo>;

export function registerOpenAICompatibleProvider(registry: ProviderRegistry, logger: Logger): void {
	registry.registerModelFetcher(
		"openai-compatible",
		createCachedModelFetcher<ApiKeyCredentials>({
			providerId: "openai-compatible",
			resolveUrl: (credentials) => {
				const base = (credentials.baseUrl ?? "").replace(/\/+$/, "");
				return new URL("models", base + "/").toString();
			},
			hasCredentials: (credentials) => Boolean(credentials.baseUrl),
			createHeaders: (credentials): Record<string, string> =>
				credentials.apiKey ? { Authorization: `Bearer ${credentials.apiKey}` } : {},
			parseResponse: (data) => {
				const typedData = data as {
					data: Array<{ id: string; object?: string; owned_by?: string }>;
				};

				return typedData.data.map((model) => ({
					id: model.id,
					name: model.id,
					providerId: "openai-compatible",
					...OPENAI_COMPATIBLE_DEFAULTS,
				}));
			},
			fallbackModels: [],
			logger,
		}),
	);

	registry.registerClientFactory("openai-compatible", (credentials) => {
		if (credentials.type !== "apikey") {
			throw new Error(
				`openai-compatible provider requires API key credentials, got: ${credentials.type}`,
			);
		}
		// customHeaders are injected by the custom fetch wrapper; passing them
		// to OpenAIClient's SDK `headers` option as well would be redundant.
		return new OpenAIClient(
			credentials.apiKey,
			credentials.baseUrl,
			"completions",
			createOpenAICompatibleFetch(
				"OpenAI Compatible",
				credentials.apiKey,
				credentials.customHeaders,
			),
		);
	});
}
