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

/**
 * Default bound on one complete fresh-discovery operation — the base request
 * (or provider-owned `fetchFresh`) plus the optional enrichment pass. 15
 * seconds preserves the per-provider envelope Node surfaces already apply
 * around model discovery; callers may configure a shorter deadline only as an
 * explicit surface policy via `discoveryDeadlineMs`.
 */
export const DEFAULT_DISCOVERY_DEADLINE_MS = 15_000;

interface CachedModelFetcherCommonConfig<T extends ProviderCredentials = ProviderCredentials> {
	/** Provider ID for logging */
	providerId: string;

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

	/**
	 * Optional: partition the cache by credential identity rather than sharing
	 * one entry across every call. Providers whose credentials can legitimately
	 * change between calls to the same registered fetcher (e.g. Connect, where
	 * `baseUrl` names a different server per credential set) should return a
	 * stable opaque fingerprint of the parts of `T` that determine the fetched
	 * model list. Never return a credential secret itself. Omitted means every
	 * call shares one cache entry, matching prior behavior.
	 */
	cacheKey?: (credentials: T) => string | Promise<string>;

	/**
	 * Maximum credential-partitioned entries retained by this fetcher. The
	 * oldest entry is evicted when the bound is exceeded. Defaults to 32 when
	 * `cacheKey` is supplied and 1 otherwise.
	 */
	maxCacheEntries?: number;

	/**
	 * Optional: Enrich models with additional data after initial fetch
	 * Useful for providers that need multiple API calls per model (e.g., Ollama /api/show)
	 *
	 * Example for Ollama:
	 * enrichModels: async (models, credentials, signal) => {
	 *   return Promise.all(models.map(async (model) => {
	 *     const details = await fetchModelDetails(model.id, credentials.endpoint, signal);
	 *     return { ...model, supportsTools: details.capabilities?.includes('tools') };
	 *   }));
	 * }
	 *
	 * `signal` aborts when the discovery deadline expires — pass it to every
	 * nested request so enrichment work is cancelled cooperatively.
	 */
	enrichModels?: (models: ModelInfo[], credentials: T, signal: AbortSignal) => Promise<ModelInfo[]>;

	/** Static fallback models if API fails */
	fallbackModels: ModelInfo[];

	/** Cache TTL in milliseconds (default: 60 minutes) */
	ttl?: number;

	/**
	 * Discovery deadline in milliseconds (default: 15 seconds). One bound
	 * covering the whole fresh-discovery operation: the base request (or
	 * provider-owned `fetchFresh`) and the optional enrichment pass. On expiry
	 * the fetcher aborts the in-flight work cooperatively (via `AbortSignal`)
	 * and falls back to the stale cache, then `fallbackModels`; a callback
	 * that ignores the signal is raced out and can neither hold the caller
	 * nor overwrite the cache.
	 */
	discoveryDeadlineMs?: number;

	/** Logger for diagnostics */
	logger: Logger;
}

/**
 * The single-request variant: the wrapper resolves one URL, builds headers,
 * performs the fetch (merging allowed custom headers additively), and parses
 * the response.
 */
export interface CachedModelFetcherRequestConfig<
	T extends ProviderCredentials = ProviderCredentials,
> extends CachedModelFetcherCommonConfig<T> {
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

	/** Function to create fetch headers from credentials */
	createHeaders: (credentials: T) => Record<string, string>;

	/** Function to parse API response into ModelInfo[] */
	parseResponse: (data: unknown) => ModelInfo[];
}

/**
 * The provider-owned-fetch variant: the provider performs the whole fresh
 * fetch itself (multi-request pagination, per-operation header policy, mode
 * short-circuits). The wrapper contributes only the credential guard and the
 * fresh → stale-cache → fallback policy. Note this variant bypasses the
 * wrapper's custom-header merge — the provider owns its discovery headers.
 */
export interface CachedModelFetcherFetchFreshConfig<
	T extends ProviderCredentials = ProviderCredentials,
> extends CachedModelFetcherCommonConfig<T> {
	/**
	 * Fetch a fresh model list. A throw falls back to stale cache, then
	 * `fallbackModels`. `signal` aborts when the discovery deadline expires —
	 * pass it to every nested request so multi-request discovery is cancelled
	 * cooperatively.
	 */
	fetchFresh: (credentials: T, signal: AbortSignal) => Promise<ModelInfo[]>;
}

export type CachedModelFetcherConfig<T extends ProviderCredentials = ProviderCredentials> =
	| CachedModelFetcherRequestConfig<T>
	| CachedModelFetcherFetchFreshConfig<T>;

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
 *
 * One discovery deadline (default 15 seconds, configurable via
 * `discoveryDeadlineMs`) bounds the complete fresh-discovery operation — the
 * base request or provider-owned `fetchFresh`, plus the optional enrichment
 * pass. The deadline aborts an `AbortController` whose signal is handed to
 * the request `fetch` and to the `fetchFresh`/`enrichModels` callbacks for
 * cooperative cancellation, and the operation is raced against the deadline
 * so a callback that ignores cancellation still cannot hold the caller. A
 * timed-out operation falls back exactly like a failed one (stale cache, then
 * `fallbackModels`) and never writes the cache; likewise, a fetch that spans
 * `clearCache()` may still answer its own caller but must not repopulate a
 * newer cache generation.
 */
const DEFAULT_CACHE_KEY = "__default__";
const DEFAULT_MAX_KEYED_CACHE_ENTRIES = 32;

interface CacheEntry {
	models: ModelInfo[];
	fetchedAt: number;
}

export function createCachedModelFetcher<T extends ProviderCredentials = ProviderCredentials>(
	config: CachedModelFetcherConfig<T>,
): ClearableModelFetcher {
	const TTL = config.ttl ?? DEFAULT_TTL;
	const discoveryDeadlineMs = config.discoveryDeadlineMs ?? DEFAULT_DISCOVERY_DEADLINE_MS;
	const maxCacheEntries =
		config.maxCacheEntries ?? (config.cacheKey ? DEFAULT_MAX_KEYED_CACHE_ENTRIES : 1);
	if (!Number.isInteger(maxCacheEntries) || maxCacheEntries < 1) {
		throw new Error("maxCacheEntries must be a positive integer");
	}
	// Keyed by `config.cacheKey` (default: one shared entry, matching prior
	// behavior) so credentials that resolve to different backends never share
	// a cached model list. Insertion order supplies bounded FIFO eviction;
	// refreshing an existing key moves it to the back.
	const cache = new Map<string, CacheEntry>();
	// Generation guard: a fetch that spans clearCache() may still answer its
	// own caller, but must not repopulate the cache over a newer generation.
	// Shared across keys — clearCache() invalidates the whole fetcher.
	let generation = 0;

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

		const cacheKey = config.cacheKey ? await config.cacheKey(typedCredentials) : DEFAULT_CACHE_KEY;
		const cached = cache.get(cacheKey);

		// Check cache freshness
		const now = Date.now();
		if (cached && now - cached.fetchedAt < TTL) {
			config.logger.debug(`${logPrefix} Using cached models`);
			return cached.models;
		}

		// One deadline covers the base request (or provider-owned fetchFresh)
		// and the enrichment pass. The AbortSignal gives nested requests
		// cooperative cancellation; the race below guarantees the caller is
		// released even if a callback ignores the signal.
		const startedIn = generation;
		const controller = new AbortController();
		const timeoutError = new Error(`Model discovery timed out after ${discoveryDeadlineMs}ms`);
		const timer = setTimeout(() => controller.abort(timeoutError), discoveryDeadlineMs);
		// A pending deadline must not, on its own, keep the process alive.
		timer.unref?.();

		// The complete fresh-discovery operation. Late settlement after a
		// timeout is harmless: the race below already settled, this promise's
		// rejection is handled by it, and the result is never cached.
		const discovery = (async (): Promise<ModelInfo[]> => {
			let freshModels: ModelInfo[];
			if ("fetchFresh" in config) {
				config.logger.debug(`${logPrefix} Fetching models via provider-owned fetch`);
				freshModels = await config.fetchFresh(typedCredentials, controller.signal);
			} else {
				// Resolve URL (either static or dynamic)
				const apiUrl = config.resolveUrl ? config.resolveUrl(typedCredentials) : config.apiUrl!;

				config.logger.debug(`${logPrefix} Fetching models from API`);
				const apiKeyCreds = typedCredentials as Partial<ApiKeyCredentials>;
				const providerHeaders = config.createHeaders(typedCredentials);
				const headers = additiveHeaderRecord(providerHeaders, apiKeyCreds.customHeaders);
				const response = await fetch(apiUrl, { headers, signal: controller.signal });

				if (!response.ok) {
					throw new Error(`API returned ${response.status}`);
				}

				const data = await response.json();
				freshModels = config.parseResponse(data);
			}

			// Enrich models with additional data if enricher provided
			if (config.enrichModels) {
				try {
					config.logger.debug(`${logPrefix} Enriching models with additional details`);
					freshModels = await config.enrichModels(freshModels, typedCredentials, controller.signal);
				} catch (enrichError) {
					// A deadline abort during enrichment fails the whole discovery
					// (the race has already fallen back); it is not a partial
					// enrichment failure to recover from.
					if (controller.signal.aborted) {
						throw enrichError;
					}
					const enrichErrorMsg =
						enrichError instanceof Error ? enrichError.message : String(enrichError);
					config.logger.warn(
						`${logPrefix} Model enrichment failed: ${enrichErrorMsg}, using base models`,
					);
					// Continue with unenriched models
				}
			}
			return freshModels;
		})();

		const deadline = new Promise<never>((_, reject) => {
			controller.signal.addEventListener("abort", () => reject(timeoutError), { once: true });
		});

		// Try to fetch from API
		try {
			const freshModels = await Promise.race([discovery, deadline]);
			if (generation === startedIn) {
				// Update cache
				cache.delete(cacheKey);
				cache.set(cacheKey, { models: freshModels, fetchedAt: now });
				while (cache.size > maxCacheEntries) {
					const oldestKey = cache.keys().next().value;
					if (oldestKey === undefined) break;
					cache.delete(oldestKey);
				}
				config.logger.info(`${logPrefix} Fetched ${freshModels.length} models from API`);
			} else {
				config.logger.debug(
					`${logPrefix} Cache cleared during fetch; returning models without caching`,
				);
			}
			return freshModels;
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			config.logger.warn(`${logPrefix} API fetch failed: ${errorMsg}, using fallback`);

			// Return stale cache if available
			if (cached) {
				config.logger.debug(`${logPrefix} Returning stale cached models`);
				return cached.models;
			}

			// Ultimate fallback
			return config.fallbackModels;
		} finally {
			clearTimeout(timer);
		}
	};

	fetcher.clearCache = () => {
		generation += 1;
		cache.clear();
	};

	return fetcher;
}
