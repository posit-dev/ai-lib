/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * OpenCode Go and Zen providers.
 *
 * Both products are OpenAI-style `/v1` surfaces on `opencode.ai`
 * (`/zen/go/v1` and `/zen/v1`, catalogued as built-in provider ids
 * `opencode-go` and `opencode-zen` with client kind `openai`). The catalog
 * supplies the product base URL via `PROVIDER_CONNECTION_DEFAULTS`; both the
 * fetcher and the client factory consume the RESOLVED `credentials.baseUrl`,
 * so a configured `providers.opencode-*.baseUrl` override reaches discovery
 * and chat — the ai-config constant is only the fallback when credentials
 * carry no URL at all.
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

import {
	getOpencodeModelCapabilities,
	OPENCODE_GO_BASE_URL,
	OPENCODE_ZEN_BASE_URL,
} from "ai-config";

import { OpenAIClient } from "../model-clients/OpenAIClient";
import type { ApiKeyCredentials, Logger, ModelInfo } from "../types";
import { createCachedModelFetcher } from "./cached-model-fetcher";
import type { ClientFactory, ProviderRegistry } from "./ProviderRegistry";

/** The two built-in OpenCode product provider ids. */
export type OpencodeProviderId = "opencode-go" | "opencode-zen";

/** Per-product fallback base URLs (the catalog default is the primary source). */
const DEFAULT_BASE_URLS: Record<OpencodeProviderId, string> = {
	"opencode-go": OPENCODE_GO_BASE_URL,
	"opencode-zen": OPENCODE_ZEN_BASE_URL,
};

interface OpencodeModelsResponse {
	data?: Array<{ id: string; object: string }>;
}

function parseOpencodeModels(providerId: OpencodeProviderId, data: unknown): ModelInfo[] {
	const entries = (data as OpencodeModelsResponse).data ?? [];
	return entries.map((model) => {
		const caps = getOpencodeModelCapabilities(model.id);
		return {
			id: model.id,
			name: model.id,
			providerId,
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

function createOpencodeModelFetcher(
	providerId: OpencodeProviderId,
	logger: Logger,
	userAgent?: string,
) {
	return createCachedModelFetcher<ApiKeyCredentials>({
		providerId,
		userAgent,
		resolveUrl: (credentials) => {
			const base = (credentials.baseUrl?.trim() || DEFAULT_BASE_URLS[providerId]).replace(
				/\/+$/,
				"",
			);
			return `${base}/models`;
		},
		hasCredentials: (credentials) => Boolean(credentials.apiKey),
		createHeaders: (credentials) => ({
			Authorization: `Bearer ${credentials.apiKey}`,
		}),
		parseResponse: (data) => parseOpencodeModels(providerId, data),
		fallbackModels: [],
		logger,
	});
}

function createOpencodeClientFactory(
	providerId: OpencodeProviderId,
	userAgent?: string,
): ClientFactory {
	return (credentials) => {
		if (credentials.type !== "apikey") {
			throw new Error(`OpenCode provider requires API key credentials, got: ${credentials.type}`);
		}
		const baseUrl =
			credentials.baseUrl?.trim().replace(/\/+$/, "") || DEFAULT_BASE_URLS[providerId];
		return new OpenAIClient({
			apiKey: credentials.apiKey,
			baseUrl,
			apiMode: "completions",
			customHeaders: credentials.customHeaders,
			userAgent,
		});
	};
}

/**
 * Register one built-in OpenCode provider (`opencode-go` or `opencode-zen`).
 * Fetcher and factory are keyed by the provider id, so each product keeps an
 * independent cache and its own default base URL.
 */
export function registerOpencodeProvider(
	registry: ProviderRegistry,
	providerId: OpencodeProviderId,
	logger: Logger,
	userAgent?: string,
): void {
	registry.registerModelFetcher(
		providerId,
		createOpencodeModelFetcher(providerId, logger, userAgent),
	);
	registry.registerClientFactory(providerId, createOpencodeClientFactory(providerId, userAgent));
}
