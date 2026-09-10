/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * OpenCode built-in provider.
 *
 * One provider ID (`opencode`, client kind `openai`) covers both hosted
 * products — Go (`/zen/go/v1`) and Zen (`/zen/v1`). The product choice lives
 * in ai-config as the scalar `providers.opencode.product` field and resolves
 * to a base URL at catalog build time, so this module stays URL-driven: both
 * the fetcher and the client factory consume the RESOLVED
 * `credentials.baseUrl`, falling back to the ai-config Zen default only when
 * credentials carry no URL at all.
 *
 * Because one provider ID can serve two endpoints across a product switch,
 * the discovery fetcher partitions its cache by the resolved base URL
 * (`cacheKey`, the Connect precedent) — otherwise a switch would serve the
 * previous product's catalog for up to the cache TTL.
 *
 * Chat runs on the OpenAI client with constructor `apiMode: "completions"`:
 * Chat Completions is the only probe-verified inference route (2026-09-09;
 * `/responses` exists on both products but 500s on every accessible model).
 * A per-model `protocol` stamp from `getOpencodeModelCapabilities` overrides
 * the constructor default per request if a future probe verifies Responses
 * for a model.
 *
 * Transport policy (session header, product User-Agent) is destination-based
 * in `mergeOpencodeHeaders`: requests resolving to the OpenCode endpoints
 * carry `x-opencode-session`; a base-URL override that routes away from
 * opencode.ai turns the session header off automatically.
 */

import { getOpencodeModelCapabilities, OPENCODE_ZEN_BASE_URL } from "ai-config";

import { OpenAIClient } from "../model-clients/OpenAIClient";
import type { ApiKeyCredentials, Logger, ModelInfo } from "../types";
import { createCachedModelFetcher } from "./cached-model-fetcher";
import type { ClientFactory, ProviderRegistry } from "./ProviderRegistry";

/** The built-in OpenCode provider id. */
const OPENCODE_PROVIDER_ID = "opencode";

/** Fallback base URL when credentials carry none (the Zen default product). */
const DEFAULT_BASE_URL = OPENCODE_ZEN_BASE_URL;

interface OpencodeModelsResponse {
	data?: Array<{ id: string; object: string }>;
}

function parseOpencodeModels(data: unknown): ModelInfo[] {
	const entries = (data as OpencodeModelsResponse).data ?? [];
	return entries.map((model) => {
		const caps = getOpencodeModelCapabilities(model.id);
		return {
			id: model.id,
			name: model.id,
			providerId: OPENCODE_PROVIDER_ID,
			vendor: "opencode",
			family: caps.family,
			maxInputTokens: caps.maxInputTokens,
			maxOutputTokens: caps.maxOutputTokens,
			// OpenCode publishes no separate context-window figure; treat the
			// input limit as the window (same convention as deepseek).
			maxContextLength: caps.maxInputTokens,
			supportsTools: caps.supportsTools,
			supportsImages: caps.supportsImages,
			supportsToolResultImages: false,
			supportsWebSearch: false,
			// Stamped only for probe-verified models; otherwise absent so
			// OpenAIClient applies its constructor-default apiMode.
			...(caps.protocol !== undefined ? { protocol: caps.protocol } : {}),
		};
	});
}

/** The resolved endpoint root for a credential set (trailing slashes stripped). */
function resolvedBaseUrl(credentials: ApiKeyCredentials): string {
	return (credentials.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function createOpencodeModelFetcher(logger: Logger, userAgent?: string) {
	return createCachedModelFetcher<ApiKeyCredentials>({
		providerId: OPENCODE_PROVIDER_ID,
		userAgent,
		resolveUrl: (credentials) => `${resolvedBaseUrl(credentials)}/models`,
		// One provider ID, two possible endpoints across a product switch:
		// partition the cache by the resolved base URL (Connect precedent) so
		// a switch refetches instead of serving the other product's catalog.
		cacheKey: (credentials) => resolvedBaseUrl(credentials),
		hasCredentials: (credentials) => Boolean(credentials.apiKey),
		createHeaders: (credentials) => ({
			Authorization: `Bearer ${credentials.apiKey}`,
		}),
		parseResponse: parseOpencodeModels,
		fallbackModels: [],
		logger,
	});
}

function createOpencodeClientFactory(userAgent?: string): ClientFactory {
	return (credentials) => {
		if (credentials.type !== "apikey") {
			throw new Error(`OpenCode provider requires API key credentials, got: ${credentials.type}`);
		}
		return new OpenAIClient({
			apiKey: credentials.apiKey,
			baseUrl: resolvedBaseUrl(credentials),
			apiMode: "completions",
			customHeaders: credentials.customHeaders,
			userAgent,
		});
	};
}

/**
 * Register the built-in OpenCode provider. The catalog-resolved
 * `credentials.baseUrl` selects the product endpoint; discovery is cached
 * per resolved base URL so a product switch refetches immediately.
 */
export function registerOpencodeProvider(
	registry: ProviderRegistry,
	logger: Logger,
	userAgent?: string,
): void {
	registry.registerModelFetcher(
		OPENCODE_PROVIDER_ID,
		createOpencodeModelFetcher(logger, userAgent),
	);
	registry.registerClientFactory(OPENCODE_PROVIDER_ID, createOpencodeClientFactory(userAgent));
}
