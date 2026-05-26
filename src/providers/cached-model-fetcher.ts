/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cached Model Fetcher Utility
 *
 * Reusable cached fetch pattern for model discovery from provider APIs.
 * Used by: Anthropic, OpenAI, OpenRouter, Ollama (local), LM Studio (local)
 */

import { additiveHeaderRecord } from "../custom-headers";
import type { ApiKeyCredentials, Logger, ModelInfo, ProviderCredentials } from "../types";

const DEFAULT_TTL = 60 * 60 * 1000; // 60 minutes

export interface CachedModelFetcherConfig<T extends ProviderCredentials = ProviderCredentials> {
	/** Provider ID for logging */
	providerId: string;

	/**
	 * API endpoint URL (static)
	 * Either apiUrl or resolveUrl must be provided
	 */
	apiUrl?: string;

	/**
	 * Dynamic URL resolver (for providers with user-configured endpoints)
	 * Either apiUrl or resolveUrl must be provided
	 *
	 * Example for Ollama:
	 * resolveUrl: (creds) => `${creds.endpoint}/api/tags`
	 */
	resolveUrl?: (credentials: T) => string;

	/**
	 * Predicate to check if credentials are present and valid
	 *
	 * Examples:
	 * - API key providers: (c) => Boolean(c.apiKey)
	 * - OAuth providers: (c) => Boolean(c.accessToken)
	 * - Local providers: (c) => Boolean(c.endpoint)
	 * - AWS providers: (c) => Boolean(c.region)
	 */
	hasCredentials: (credentials: T) => boolean;

	/** Function to create fetch headers from credentials */
	createHeaders: (credentials: T) => Record<string, string>;

	/** Function to parse API response into ModelInfo[] */
	parseResponse: (data: unknown) => ModelInfo[];

	/**
	 * Optional: Enrich models with additional data after initial fetch
	 * Useful for providers that need multiple API calls per model (e.g., Ollama /api/show)
	 *
	 * Example for Ollama:
	 * enrichModels: async (models, credentials) => {
	 *   return Promise.all(models.map(async (model) => {
	 *     const details = await fetchModelDetails(model.id, credentials.endpoint);
	 *     return { ...model, supportsTools: details.capabilities?.includes('tools') };
	 *   }));
	 * }
	 */
	enrichModels?: (models: ModelInfo[], credentials: T) => Promise<ModelInfo[]>;

	/** Static fallback models if API fails */
	fallbackModels: ModelInfo[];

	/** Cache TTL in milliseconds (default: 60 minutes) */
	ttl?: number;

	/** Logger for diagnostics */
	logger: Logger;
}

/**
 * A ModelFetcher with an optional clearCache method for invalidation.
 */
export type ClearableModelFetcher = ((credentials: ProviderCredentials) => Promise<ModelInfo[]>) & {
	clearCache?: () => void;
};

/**
 * Create a model fetcher with closure-based caching and graceful fallback
 *
 * Pattern used by: Anthropic, OpenAI, OpenRouter, Ollama (local), LM Studio (local)
 *
 * Three-level fallback strategy:
 * 1. Fresh fetch from API (if credentials present and cache expired)
 * 2. Stale cache (if fresh fetch fails but cache exists)
 * 3. Static fallback models (if no cache available)
 */
export function createCachedModelFetcher<T extends ProviderCredentials = ProviderCredentials>(
	config: CachedModelFetcherConfig<T>,
): ClearableModelFetcher {
	const TTL = config.ttl ?? DEFAULT_TTL;
	let lastFetch = 0;
	let cachedModels: ModelInfo[] | null = null;

	const fetcher: ClearableModelFetcher = async (
		credentials: ProviderCredentials,
	): Promise<ModelInfo[]> => {
		const logPrefix = `[${config.providerId}]`;
		// Cast to T for type-safe callbacks (safe at runtime as correct type is always passed)
		const typedCredentials = credentials as T;

		// Guard: Check if credentials are present
		if (!config.hasCredentials(typedCredentials)) {
			config.logger.debug(`${logPrefix} No credentials, using fallback models`);
			return config.fallbackModels;
		}

		// Check cache freshness
		const now = Date.now();
		if (cachedModels && now - lastFetch < TTL) {
			config.logger.debug(`${logPrefix} Using cached models`);
			return cachedModels;
		}

		// Try to fetch from API
		try {
			// Resolve URL (either static or dynamic)
			const apiUrl = config.resolveUrl ? config.resolveUrl(typedCredentials) : config.apiUrl!;

			config.logger.debug(`${logPrefix} Fetching models from API`);
			const apiKeyCreds = typedCredentials as Partial<ApiKeyCredentials>;
			const providerHeaders = config.createHeaders(typedCredentials);
			const headers = additiveHeaderRecord(providerHeaders, apiKeyCreds.customHeaders);
			const response = await fetch(apiUrl, { headers });

			if (!response.ok) {
				throw new Error(`API returned ${response.status}`);
			}

			const data = await response.json();
			let freshModels = config.parseResponse(data);

			// Enrich models with additional data if enricher provided
			if (config.enrichModels) {
				try {
					config.logger.debug(`${logPrefix} Enriching models with additional details`);
					freshModels = await config.enrichModels(freshModels, typedCredentials);
				} catch (enrichError) {
					const enrichErrorMsg =
						enrichError instanceof Error ? enrichError.message : String(enrichError);
					config.logger.warn(
						`${logPrefix} Model enrichment failed: ${enrichErrorMsg}, using base models`,
					);
					// Continue with unenriched models
				}
			}

			// Update cache
			lastFetch = now;
			cachedModels = freshModels;
			config.logger.info(`${logPrefix} Fetched ${freshModels.length} models from API`);
			return freshModels;
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			config.logger.warn(`${logPrefix} API fetch failed: ${errorMsg}, using fallback`);

			// Return stale cache if available
			if (cachedModels) {
				config.logger.debug(`${logPrefix} Returning stale cached models`);
				return cachedModels;
			}

			// Ultimate fallback
			return config.fallbackModels;
		}
	};

	fetcher.clearCache = () => {
		cachedModels = null;
		lastFetch = 0;
	};

	return fetcher;
}
