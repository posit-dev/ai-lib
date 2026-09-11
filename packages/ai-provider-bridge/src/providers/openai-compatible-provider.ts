/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ResolvedProviderId } from "ai-config";

import { createOpenAICompatibleFetchMiddleware } from "../model-clients/openai-compat-fetch";
import { OpenAIClient } from "../model-clients/OpenAIClient";
import type { Logger, ModelInfo } from "../types";
import type { ApiKeyCredentials } from "../types";
import { createCachedModelFetcher } from "./cached-model-fetcher";
import type { ClientFactory, ProviderRegistry } from "./ProviderRegistry";

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

function createOpenAICompatibleModelFetcher(providerId: ResolvedProviderId, logger: Logger) {
	return createCachedModelFetcher<ApiKeyCredentials>({
		providerId,
		resolveUrl: (credentials) => {
			const base = (credentials.baseUrl?.trim() || "").replace(/\/+$/, "");
			return new URL("models", base + "/").toString();
		},
		hasCredentials: (credentials) => Boolean(credentials.baseUrl?.trim()),
		createHeaders: (credentials): Record<string, string> =>
			credentials.apiKey ? { Authorization: `Bearer ${credentials.apiKey}` } : {},
		parseResponse: (data) => {
			const typedData = data as {
				data: Array<{ id: string; object?: string; owned_by?: string }>;
			};

			return typedData.data.map((model) => ({
				id: model.id,
				name: model.id,
				providerId,
				...OPENAI_COMPATIBLE_DEFAULTS,
			}));
		},
		fallbackModels: [],
		logger,
	});
}

const openAICompatibleClientFactory: ClientFactory = (credentials) => {
	if (credentials.type !== "apikey") {
		throw new Error(
			`openai-compatible provider requires API key credentials, got: ${credentials.type}`,
		);
	}
	// customHeaders are injected by the custom fetch wrapper; passing them
	// to OpenAIClient's SDK `headers` option as well would be redundant.
	return new OpenAIClient({
		apiKey: credentials.apiKey,
		baseUrl: credentials.baseUrl?.trim(),
		apiMode: "completions",
		customFetch: createOpenAICompatibleFetchMiddleware(
			"OpenAI Compatible",
			credentials.apiKey,
			credentials.customHeaders,
		),
	});
};

/** Register the built-in `openai-compatible` provider. */
export function registerOpenAICompatibleProvider(registry: ProviderRegistry, logger: Logger): void {
	registry.registerModelFetcher(
		"openai-compatible",
		createOpenAICompatibleModelFetcher("openai-compatible", logger),
	);
	registry.registerClientFactory("openai-compatible", openAICompatibleClientFactory);
}

/**
 * Register a `providers.custom` entry with `type: "openai-compatible"`.
 *
 * Discovery is custom-id keyed so each endpoint has independent cache state
 * and its models carry the custom id. The client factory is kind-keyed so a
 * live type change resolves through the catalog's current `clientKind`
 * instead of leaving a stale factory registered under the custom id.
 */
export function registerCustomOpenAICompatibleProvider(
	registry: ProviderRegistry,
	providerId: ResolvedProviderId,
	logger: Logger,
): void {
	registry.registerModelFetcher(providerId, createOpenAICompatibleModelFetcher(providerId, logger));
	registry.registerClientFactory("openai-compatible", openAICompatibleClientFactory);
}
