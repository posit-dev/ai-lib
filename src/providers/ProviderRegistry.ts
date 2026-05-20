/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider Plugin Registry - Backend Plugin System
 *
 * This registry allows providers to register their backend implementations
 * (model fetchers and client factories) without modifying core services.
 *
 * Adding a new provider requires:
 * 1. Registering a model fetcher (async function that returns ModelInfo[])
 * 2. Registering a client factory (function that creates a ModelClient)
 */

import type { ModelClient } from "../model-clients/ModelClient";
import type { Logger, ModelInfo, ProviderCredentials } from "../types";

/**
 * Function that fetches models for a provider
 * Called when auth status changes or models need refreshing
 *
 * @param credentials - Provider credentials (API key, token, endpoint, etc.)
 * @param metadata - Optional provider-specific metadata from auth status
 * @returns Array of available models for this provider
 */
export type ModelFetcher = (
	credentials: ProviderCredentials,
	metadata?: Record<string, unknown>,
) => Promise<ModelInfo[]>;

type ClearableModelFetcher = ModelFetcher & {
	clearCache?: () => void;
	getFetchState?: () => unknown;
};

/**
 * Function that creates an API client for a provider
 * Called when making chat requests to this provider
 *
 * @param credentials - Provider credentials
 * @returns ModelClient instance for making API calls
 */
export type ClientFactory = (credentials: ProviderCredentials) => ModelClient;

/**
 * Registry for provider implementations
 *
 * Providers register their backend implementations here:
 * - Model fetcher: Returns list of available models
 * - Client factory: Creates API client for chat requests
 *
 * The registry is used by ModelService to discover models and send requests
 * without hard-coded provider logic.
 */
export class ProviderRegistry {
	private modelFetchers = new Map<string, ClearableModelFetcher>();
	private clientFactories = new Map<string, ClientFactory>();

	constructor(private readonly logger: Logger) {}

	/**
	 * Register a model fetcher for a provider
	 *
	 * @param providerId - Provider ID (e.g., "anthropic", "openrouter")
	 * @param fetcher - Async function that returns models
	 */
	registerModelFetcher(providerId: string, fetcher: ModelFetcher): void {
		this.modelFetchers.set(providerId, fetcher as ClearableModelFetcher);
	}

	/**
	 * Register a client factory for a provider
	 *
	 * @param providerId - Provider ID
	 * @param factory - Function that creates ModelClient
	 */
	registerClientFactory(providerId: string, factory: ClientFactory): void {
		this.clientFactories.set(providerId, factory);
	}

	/**
	 * Get models for a provider
	 * Returns empty array if provider not registered or fetch fails
	 *
	 * @param providerId - Provider ID
	 * @param credentials - Provider credentials
	 * @param metadata - Optional provider metadata
	 * @returns Array of models or empty array
	 */
	async getModelsForProvider(
		providerId: string,
		credentials: ProviderCredentials,
		metadata?: Record<string, unknown>,
	): Promise<ModelInfo[]> {
		const fetcher = this.modelFetchers.get(providerId);

		if (!fetcher) {
			this.logger.warn(`No model fetcher registered for ${providerId}`);
			return [];
		}

		try {
			return await fetcher(credentials, metadata);
		} catch (error) {
			this.logger.error(`Error fetching models for ${providerId}:`, error);
			return [];
		}
	}

	/**
	 * Clear all provider-level model caches.
	 * Called when credentials change (sign-out, key removal) to ensure
	 * the next model fetch hits the API instead of returning stale data.
	 */
	clearAllModelCaches(): void {
		for (const [providerId, fetcher] of this.modelFetchers) {
			if (fetcher.clearCache) {
				this.logger.debug(`[ProviderRegistry] Clearing model cache for ${providerId}`);
				fetcher.clearCache();
			}
		}
	}

	clearModelCache(providerId: string): void {
		const fetcher = this.modelFetchers.get(providerId);
		if (fetcher?.clearCache) {
			this.logger.debug(`[ProviderRegistry] Clearing model cache for ${providerId}`);
			fetcher.clearCache();
		}
	}

	getModelFetchState<T>(providerId: string): T | undefined {
		const fetcher = this.modelFetchers.get(providerId);
		if (!fetcher?.getFetchState) {
			return undefined;
		}
		return fetcher.getFetchState() as T | undefined;
	}

	/**
	 * Get client for a provider
	 * Returns null if provider not registered
	 *
	 * @param providerId - Provider ID
	 * @param credentials - Provider credentials
	 * @returns ModelClient or null
	 */
	getClientForProvider(providerId: string, credentials: ProviderCredentials): ModelClient | null {
		const factory = this.clientFactories.get(providerId);

		if (!factory) {
			this.logger.warn(`No client factory registered for ${providerId}`);
			return null;
		}

		return factory(credentials);
	}
}
