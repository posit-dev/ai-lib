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
 * Transport policy: the session header is owned by this provider. Every chat
 * request builds its delegate with `x-opencode-session` set to the
 * host-supplied `rootConversationId` in `customHeaders` — the generated value
 * wins over any static case-variant of the header, and with no root metadata
 * no header is generated (a static one survives). Because the header rides on
 * the provider rather than a URL matcher, a per-request `baseUrl` override
 * keeps it: it is harmless on a non-OpenCode destination, and a custom
 * provider pointed AT an OpenCode endpoint is not the supported path.
 * Authentication is per-route, probe-verified on both products
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

/** Header that carries the conversation routing identity to OpenCode. */
const SESSION_HEADER_NAME = "x-opencode-session";

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

/**
 * Copy `customHeaders` with `x-opencode-session` set to the host-supplied
 * root conversation identity. The generated value wins: any case-variant of
 * the header already present (a static custom-header workaround) is replaced.
 * With no root identity the record is returned unchanged — no session header
 * is generated and a static one survives. No other header is touched.
 */
function withOpencodeSessionHeader(
	customHeaders: Record<string, string> | undefined,
	rootConversationId: string | undefined,
): Record<string, string> | undefined {
	if (rootConversationId === undefined) {
		return customHeaders;
	}
	const merged: Record<string, string> = {};
	for (const [name, value] of Object.entries(customHeaders ?? {})) {
		if (name.toLowerCase() === SESSION_HEADER_NAME) {
			continue;
		}
		merged[name] = value;
	}
	merged[SESSION_HEADER_NAME] = rootConversationId;
	return merged;
}

function createOpencodeModelFetcher(logger: Logger) {
	return createCachedModelFetcher<ApiKeyCredentials>({
		providerId: OPENCODE_PROVIDER_ID,
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

function createOpencodeClientFactory(logger: Logger): ClientFactory {
	return (credentials) => {
		if (credentials.type !== "apikey") {
			throw new Error(`OpenCode provider requires API key credentials, got: ${credentials.type}`);
		}
		const baseUrl = resolvedBaseUrl(credentials);
		const { apiKey, customHeaders } = credentials;

		// The delegate is built per request, dispatched on the resolved
		// protocol (the Databricks composition precedent), with the session
		// header already in its `customHeaders`. A client object holds only
		// config — each of the three delegates builds its SDK connection
		// inside `chat()` — so per-request construction adds no connection or
		// cache cost. All delegates receive the API root — the SDKs append
		// only their operation paths (`/responses`, `/chat/completions`,
		// `/messages`, `/models/{model}:generateContent`). Unlike Databricks,
		// the native delegates run in each SDK's NATIVE auth mode: OpenCode's
		// Messages and generateContent routes read
		// `x-api-key`/`x-goog-api-key`, not `Authorization: Bearer`
		// (probe-verified 2026-09-11, see module doc).
		const createDelegate = (
			model: string,
			protocol: Protocol,
			headers: Record<string, string> | undefined,
		): ModelClient => {
			switch (protocol) {
				case "openai-chat":
				case "openai-responses":
					return new OpenAIClient({
						apiKey,
						baseUrl,
						apiMode: "completions",
						customHeaders: headers,
					});
				case "anthropic-messages":
					return new AnthropicClient({ apiKey }, baseUrl, headers, logger);
				case "google-generative":
					return new GeminiGenerateContentClient({ apiKey }, baseUrl, headers, logger);
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
				const headers = withOpencodeSessionHeader(
					customHeaders,
					params.metadata?.rootConversationId,
				);
				const delegate = createDelegate(params.model, protocol, headers);
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
export function registerOpencodeProvider(registry: ProviderRegistry, logger: Logger): void {
	registry.registerModelFetcher(OPENCODE_PROVIDER_ID, createOpencodeModelFetcher(logger));
	registry.registerClientFactory(OPENCODE_PROVIDER_ID, createOpencodeClientFactory(logger));
}
