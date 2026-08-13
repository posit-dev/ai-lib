/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ResolvedProviderId } from "ai-config";
import { getDeepSeekModelCapabilities } from "ai-config";

import { DeepSeekClient } from "../model-clients/DeepSeekClient";
import type { ApiKeyCredentials, Logger, ModelInfo } from "../types";
import { createCachedModelFetcher } from "./cached-model-fetcher";
import type { ClientFactory, ProviderRegistry } from "./ProviderRegistry";

/** DeepSeek public API host. */
const DEEPSEEK_HOST = "https://api.deepseek.com";

interface DeepSeekModel {
	id: string;
	object: string;
	owned_by?: string;
}

interface DeepSeekModelsResponse {
	object: string;
	data: DeepSeekModel[];
}

function parseDeepSeekModelsForProvider(
	providerId: ResolvedProviderId,
	data: unknown,
): ModelInfo[] {
	const typedData = data as DeepSeekModelsResponse;
	return typedData.data.map((model) => {
		const caps = getDeepSeekModelCapabilities(model.id);
		return {
			id: model.id,
			name: caps.displayName || model.id,
			providerId,
			vendor: "deepseek",
			family: caps.family,
			maxInputTokens: caps.maxInputTokens,
			maxOutputTokens: caps.maxOutputTokens,
			supportsTools: caps.supportsTools,
			supportsImages: caps.supportsImages,
			supportsToolResultImages: false,
			maxContextLength: caps.maxInputTokens,
			supportsWebSearch: false,
			thinkingEffortLevels: caps.thinkingEffortLevels,
		};
	});
}

function createDeepSeekModelFetcher(providerId: ResolvedProviderId, logger: Logger) {
	return createCachedModelFetcher<ApiKeyCredentials>({
		providerId,
		resolveUrl: (credentials) => {
			// DeepSeek accepts the host with or without `/v1`; keep the no-`/v1`
			// default to match @ai-sdk/deepseek.
			const base = (credentials.baseUrl?.trim() || DEEPSEEK_HOST).replace(/\/+$/, "");
			return `${base}/models`;
		},
		hasCredentials: (credentials) => Boolean(credentials.apiKey),
		createHeaders: (credentials) => ({
			Authorization: `Bearer ${credentials.apiKey}`,
		}),
		parseResponse: (data) => parseDeepSeekModelsForProvider(providerId, data),
		fallbackModels: [],
		logger,
		ttl: 60 * 60 * 1000,
	});
}

const deepSeekClientFactory: ClientFactory = (credentials) => {
	if (credentials.type !== "apikey") {
		throw new Error(`DeepSeek provider requires API key credentials, got: ${credentials.type}`);
	}
	// undefined when unset so the SDK keeps its default.
	const baseUrl = credentials.baseUrl?.trim().replace(/\/+$/, "") || undefined;
	return new DeepSeekClient(credentials.apiKey, baseUrl, credentials.customHeaders);
};

export function registerDeepSeekProvider(registry: ProviderRegistry, logger: Logger): void {
	registry.registerModelFetcher("deepseek", createDeepSeekModelFetcher("deepseek", logger));
	registry.registerClientFactory("deepseek", deepSeekClientFactory);
}

export function registerCustomDeepSeekProvider(
	registry: ProviderRegistry,
	providerId: ResolvedProviderId,
	logger: Logger,
): void {
	registry.registerModelFetcher(providerId, createDeepSeekModelFetcher(providerId, logger));
	registry.registerClientFactory("deepseek", deepSeekClientFactory);
}
