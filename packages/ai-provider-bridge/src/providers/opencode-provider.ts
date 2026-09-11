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
 * `credentials.baseUrl`, falling back to the ai-config default product's
 * endpoint only when credentials carry no URL at all.
 *
 * Because one provider ID can serve two endpoints across a product switch,
 * the discovery fetcher partitions its cache by the resolved base URL
 * (`cacheKey`, the Connect precedent) — otherwise a switch would serve the
 * previous product's catalog for up to the cache TTL.
 *
 * Routing: each discovered model is stamped with its DOCUMENTED wire protocol
 * by an `enrichModels` pass over the payload-only parse — ai-config's
 * `inferOpencodeProtocol` owns the product-aware id → protocol mapping
 * (MiniMax is Messages on Go but Chat Completions on Zen), and the stamp is
 * recomputed downstream with full routing context, so it is a default, never
 * user intent. Chat dispatches per request on the normalized resolved
 * protocol to one of three delegates sharing the API root: OpenAI (Chat
 * Completions and Responses), Anthropic (Messages), and Gemini
 * (generateContent). A direct chat call with no protocol at all — the
 * registry permits chat without discovery — falls back to the same routing
 * helper; an explicit request protocol always wins.
 *
 * Transport policy (session header, product User-Agent) is destination-based
 * in `mergeOpencodeHeaders` and applied by every delegate: requests resolving
 * to the OpenCode endpoints carry `x-opencode-session`; a base-URL override
 * that routes away from opencode.ai turns the session header off
 * automatically. Authentication is per-route, probe-verified on both products
 * 2026-09-11 (dummy-key header probes: "Invalid API key." vs "Missing API
 * key." distinguish a read header from an ignored one): the OpenAI routes
 * (`/responses`, `/chat/completions`, `/models`) read `Authorization:
 * Bearer`, while the native vendor routes read the vendor's own key header —
 * `/messages` reads `x-api-key` and generateContent reads `x-goog-api-key`.
 * Each delegate therefore runs in its SDK's native auth mode.
 */

import type { Protocol } from "ai-config";
import {
	getGeminiGenerateContentProfile,
	getOpencodeModelCapabilities,
	inferOpencodeProtocol,
	OPENCODE_DEFAULT_PRODUCT,
	OPENCODE_PRODUCT_BASE_URLS,
} from "ai-config";

import { AnthropicClient } from "../model-clients/AnthropicClient";
import { GeminiGenerateContentClient } from "../model-clients/GeminiGenerateContentClient";
import type { ModelClient } from "../model-clients/ModelClient";
import { OpenAIClient } from "../model-clients/OpenAIClient";
import type { ApiKeyCredentials, Logger, ModelInfo } from "../types";
import { normalizeProtocol } from "../types";
import { createCachedModelFetcher } from "./cached-model-fetcher";
import type { ClientFactory, ProviderRegistry } from "./ProviderRegistry";

/** The built-in OpenCode provider id. */
const OPENCODE_PROVIDER_ID = "opencode";

/** Fallback base URL when credentials carry none (the built-in default product). */
const DEFAULT_BASE_URL = OPENCODE_PRODUCT_BASE_URLS[OPENCODE_DEFAULT_PRODUCT];

interface OpencodeModelsResponse {
	data?: Array<{ id: string; object: string }>;
}

/**
 * Parse the `/models` payload into unstamped models. Deliberately
 * payload-only: the product context needed for a protocol stamp lives in the
 * credentials, so stamping happens in the fetcher's `enrichModels` pass.
 */
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
		};
	});
}

/** The resolved endpoint root for a credential set (trailing slashes stripped). */
function resolvedBaseUrl(credentials: ApiKeyCredentials): string {
	return (credentials.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/**
 * Stamp each parsed model with its documented protocol under the resolved
 * product, and drop Gemini models whose generateContent variant has no
 * verified profile: without a profile the native client cannot build correct
 * wire parameters, and silently rerouting to Chat Completions is unproven —
 * so the model is excluded here with an actionable diagnostic instead of
 * being advertised as usable. An explicit configured model with the same id
 * still resolves and surfaces the client's unsupported-variant error.
 */
function stampAndFilterProtocols(
	models: ModelInfo[],
	baseUrl: string,
	logger: Logger,
): ModelInfo[] {
	const stamped: ModelInfo[] = [];
	for (const model of models) {
		const protocol = inferOpencodeProtocol(model.id, baseUrl);
		if (protocol === "google-generative" && !getGeminiGenerateContentProfile(model.id)) {
			logger.warn(
				`[opencode] Excluding "${model.id}" from discovery: no verified generateContent ` +
					`profile for this Gemini variant, so its thinking controls cannot be wired. ` +
					`Add a variant rule to ai-config's gemini-generate-content.ts to enable it.`,
			);
			continue;
		}
		stamped.push({ ...model, protocol });
	}
	return stamped;
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
		// Enrichment runs before the product-partitioned cache stores the
		// result, so each cache entry's stamps match its own product.
		enrichModels: (models, credentials, _signal) =>
			Promise.resolve(stampAndFilterProtocols(models, resolvedBaseUrl(credentials), logger)),
		fallbackModels: [],
		logger,
	});
}

function createOpencodeClientFactory(logger: Logger, userAgent?: string): ClientFactory {
	return (credentials) => {
		if (credentials.type !== "apikey") {
			throw new Error(`OpenCode provider requires API key credentials, got: ${credentials.type}`);
		}
		const baseUrl = resolvedBaseUrl(credentials);
		const { apiKey, customHeaders } = credentials;

		// Three delegates against the same API root, dispatched per request on
		// the resolved protocol (the Databricks composition precedent). All
		// receive the API root — the SDKs append only their operation paths
		// (`/responses`, `/chat/completions`, `/messages`,
		// `/models/{model}:generateContent`). Unlike Databricks, the native
		// delegates run in each SDK's NATIVE auth mode: OpenCode's Messages and
		// generateContent routes read `x-api-key`/`x-goog-api-key`, not
		// `Authorization: Bearer` (probe-verified 2026-09-11, see module doc).
		const openaiClient = new OpenAIClient({
			apiKey,
			baseUrl,
			apiMode: "completions",
			customHeaders,
			userAgent,
		});
		const anthropicClient = new AnthropicClient(
			{ apiKey },
			baseUrl,
			customHeaders,
			logger,
			userAgent,
		);
		const geminiClient = new GeminiGenerateContentClient(
			{ apiKey },
			baseUrl,
			customHeaders,
			logger,
			userAgent,
		);

		const selectDelegate = (model: string, protocol: Protocol): ModelClient => {
			switch (protocol) {
				case "openai-chat":
				case "openai-responses":
					return openaiClient;
				case "anthropic-messages":
					return anthropicClient;
				case "google-generative":
					return geminiClient;
				default:
					throw new Error(
						`OpenCode provider cannot route model "${model}" over protocol "${protocol}"`,
					);
			}
		};

		return {
			chat: async (params) => {
				// A supplied request protocol always wins; only when the caller
				// omitted it (chat without prior discovery) does the shared
				// routing helper infer one from the model id and the effective
				// destination. The per-request baseUrl override is trusted
				// verbatim by the delegates.
				const protocol =
					normalizeProtocol(params.protocol) ??
					inferOpencodeProtocol(params.model, params.baseUrl ?? baseUrl);
				const delegate = selectDelegate(params.model, protocol);
				return delegate.chat({ ...params, protocol });
			},
		};
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
	registry.registerClientFactory(
		OPENCODE_PROVIDER_ID,
		createOpencodeClientFactory(logger, userAgent),
	);
}
