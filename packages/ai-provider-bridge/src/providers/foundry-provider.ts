/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ResolvedProviderId } from "ai-config";

import { createAzureEntraTokenProvider } from "../model-clients/azure-entra-token";
import { createOpenAICompatibleFetchMiddleware } from "../model-clients/openai-compat-fetch";
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
		// Discovery is static and never acquires a token: any credential shape
		// with a baseUrl yields the model-router entry.
		if (credentials.type === "azure-entra") {
			if (!credentials.baseUrl) {
				logger.debug("[Foundry] Entra credentials missing baseUrl, returning empty");
				return [];
			}
			return [{ ...FOUNDRY_MODEL, providerId }];
		}
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

function createFoundryClientFactory(
	credentialEnvironment?: Readonly<Record<string, string | undefined>>,
): ClientFactory {
	return (credentials) => {
		if (credentials.type === "azure-entra") {
			// Entra mode: the bearer token is injected per request around the
			// shared OpenAI-compatible fetch, which keeps owning additive
			// customHeaders and request/stream normalization. `@azure/identity`
			// caches and refreshes tokens internally, so no expiry handling
			// reaches this code. The placeholder apiKey stops the OpenAI SDK
			// from falling back to OPENAI_API_KEY; the custom fetch overwrites
			// the Authorization header before the request leaves.
			const tokenProvider = createAzureEntraTokenProvider(
				credentials.scope,
				credentials.tenantId,
				credentialEnvironment,
			);
			return new OpenAIClient({
				apiKey: "entra-token-managed",
				baseUrl: credentials.baseUrl,
				apiMode: "completions",
				customFetch: (delegate) => {
					const compatFetch = createOpenAICompatibleFetchMiddleware(
						"Foundry",
						undefined,
						credentials.customHeaders,
					)(delegate);
					return async (url, init) => {
						const token = await tokenProvider();
						const headers = new Headers(init?.headers);
						headers.set("Authorization", `Bearer ${token}`);
						return compatFetch(url, { ...init, headers });
					};
				},
			});
		}
		if (credentials.type !== "apikey") {
			throw new Error(`Foundry provider requires API key credentials, got: ${credentials.type}`);
		}
		// customHeaders are injected by the custom fetch wrapper.
		return new OpenAIClient({
			apiKey: credentials.apiKey,
			baseUrl: credentials.baseUrl,
			apiMode: "completions",
			customFetch: createOpenAICompatibleFetchMiddleware(
				"Foundry",
				credentials.apiKey,
				credentials.customHeaders,
			),
		});
	};
}

export function registerFoundryProvider(
	registry: ProviderRegistry,
	logger: Logger,
	credentialEnvironment?: Readonly<Record<string, string | undefined>>,
): void {
	registry.registerModelFetcher("ms-foundry", createFoundryModelFetcher("ms-foundry", logger));
	registry.registerClientFactory("ms-foundry", createFoundryClientFactory(credentialEnvironment));
}

export function registerCustomFoundryProvider(
	registry: ProviderRegistry,
	providerId: ResolvedProviderId,
	logger: Logger,
	credentialEnvironment?: Readonly<Record<string, string | undefined>>,
): void {
	registry.registerModelFetcher(providerId, createFoundryModelFetcher(providerId, logger));
	registry.registerClientFactory("ms-foundry", createFoundryClientFactory(credentialEnvironment));
}
