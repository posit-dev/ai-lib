/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * LiteLLM provider
 *
 * Routes each proxy alias over its natural wire protocol, all against the
 * same gateway:
 *
 * - Claude families (direct Anthropic, Bedrock, Vertex) speak the
 *   Anthropic-shaped `/v1/messages`, so explicit cache breakpoints and
 *   thinking-block round-trips survive.
 * - Recognized OpenAI reasoning models speak `/v1/responses`, which preserves
 *   our stateless `store: false` encrypted-reasoning round-trip (verified
 *   against LiteLLM 1.95.0), so they keep `thinkingEffortLevels`.
 * - Everything else (other OpenAI models, Gemini, local upstreams, …) speaks
 *   `/v1/chat/completions`.
 *
 * The fetcher stamps a per-alias `protocol` (family detection lives in
 * ai-config's `classifyLitellmModel` — the single source of truth shared with
 * capability inference); the catalog pipeline resolves it with the standard
 * precedence (user override > provider connection `protocol` > this stamp)
 * and the chat client dispatches on the resolved value per request. A
 * connection-level `protocol` therefore flattens *all* aliases to one
 * protocol — that's the admin escape hatch, not a bug.
 *
 * Model discovery uses `GET {baseUrl}/v1/model/info` (NOT `/v1/models`, which
 * is OpenAI-shaped and carries no metadata). Every `model_info` field is
 * optional in practice — local upstreams like Ollama report all-null metadata —
 * so parsing treats each field as best-effort.
 *
 * Credentials are `apikey` credentials: `baseUrl` is required (the proxy
 * address, e.g. `http://localhost:4000`); `apiKey` is optional — a proxy
 * without a master key needs no auth. LiteLLM accepts both `x-api-key` and
 * `Authorization: Bearer` on every endpoint, so the same key rides in
 * whichever scheme each delegate's SDK sends (`x-api-key` on `/v1/messages`,
 * `Bearer` on the OpenAI-shaped endpoints) and in both during discovery.
 *
 * Two registrars share the same wire knowledge:
 * - `registerLitellmProvider` — the built-in `litellm` provider.
 * - `registerCustomLitellmProvider` — a `providers.custom` entry with
 *   `type: "litellm"` (an organization's own gateway under its own name).
 *   The model fetcher is registered under the custom provider id (with its
 *   own cache, stamping that id into discovered models), while the client
 *   factory is registered under the kind key `"litellm"` only — chat routing
 *   reaches it through the registry's `clientKind` fallback, which reads the
 *   current catalog kind and therefore cannot go stale when an entry's
 *   `type` changes on a live providers.json reload.
 */

import type { ResolvedProviderId } from "ai-config";
import { classifyLitellmModel, inferModelCapabilities } from "ai-config";

import { AnthropicClient } from "../model-clients/AnthropicClient";
import { OpenAIClient } from "../model-clients/OpenAIClient";
import type { ApiKeyCredentials, Logger, ModelInfo } from "../types";
import { normalizeProtocol } from "../types";
import type { ClearableModelFetcher } from "./cached-model-fetcher";
import { createCachedModelFetcher } from "./cached-model-fetcher";
import type { ClientFactory, ProviderRegistry } from "./ProviderRegistry";

/**
 * Resolve the proxy's `/v1` API base from the configured base URL, tolerating
 * a user who already included the version segment.
 * Exported for tests.
 */
export function litellmV1BaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

// ---------------------------------------------------------------------------
// /v1/model/info parsing
// ---------------------------------------------------------------------------

interface LitellmModelInfoEntry {
	model_name?: string;
	litellm_params?: { model?: string };
	model_info?: {
		litellm_provider?: string | null;
		mode?: string | null;
		max_input_tokens?: number | null;
		max_output_tokens?: number | null;
		supports_vision?: boolean | null;
	};
}

function toModelInfo(
	entry: LitellmModelInfoEntry,
	alias: string,
	providerId: ResolvedProviderId,
): ModelInfo {
	const info = entry.model_info ?? {};

	// Family detection is single-sourced in ai-config: the classifier trusts
	// the underlying model id (`litellm_params.model`) and falls back to the
	// alias only when the entry carries no underlying id, and its
	// `capabilityModelId` feeds the shared capability-inference seam so
	// routing and capabilities always agree.
	const { family, capabilityModelId } = classifyLitellmModel({
		alias,
		underlyingModel: entry.litellm_params?.model,
		litellmProvider: info.litellm_provider,
	});
	const isClaude = family === "claude";
	const inferredCapabilities = inferModelCapabilities("litellm", capabilityModelId);

	// Per-family default protocol: Claude speaks the Anthropic-shaped route;
	// OpenAI reasoning models (the ones with thinking effort levels) get the
	// Responses route so encrypted-reasoning continuity survives; everything
	// else speaks Chat Completions.
	const protocol =
		family === "claude"
			? ("anthropic-messages" as const)
			: family === "openai" && inferredCapabilities.thinkingEffortLevels
				? ("openai-responses" as const)
				: ("openai-chat" as const);

	const model: ModelInfo = {
		id: alias,
		name: alias,
		providerId,
		...inferredCapabilities,
		vendor: isClaude ? "anthropic" : info.litellm_provider || "litellm",
		protocol,
		...(!isClaude &&
			typeof info.supports_vision === "boolean" && {
				supportsImages: info.supports_vision,
			}),
		...(typeof info.max_input_tokens === "number" && {
			maxInputTokens: info.max_input_tokens,
			maxContextLength: info.max_input_tokens,
		}),
		...(typeof info.max_output_tokens === "number" && {
			maxOutputTokens: info.max_output_tokens,
		}),
	};
	return model;
}

/**
 * Parse a `/v1/model/info` response into chat-capable models, stamped with
 * `providerId` (the built-in `"litellm"` or a custom provider id).
 * Exported for tests.
 */
export function parseLitellmModelInfoResponse(
	data: unknown,
	providerId: ResolvedProviderId = "litellm",
): ModelInfo[] {
	const entries = (data as { data?: LitellmModelInfoEntry[] }).data ?? [];

	const models: ModelInfo[] = [];
	for (const entry of entries) {
		const alias = entry.model_name;
		if (!alias) continue;
		// Keep entries with unknown mode (local upstreams report null metadata);
		// exclude only those positively identified as non-chat (embeddings,
		// image generation, audio, rerank, ...).
		const mode = entry.model_info?.mode;
		if (typeof mode === "string" && mode !== "chat") continue;
		models.push(toModelInfo(entry, alias, providerId));
	}
	return models;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Build a cached `/v1/model/info` fetcher for one gateway. Each call creates
 * its own `createCachedModelFetcher` instance, so every registered provider id
 * (the built-in plus each custom entry) gets an independent per-gateway cache.
 */
function createLitellmModelFetcher(
	providerId: ResolvedProviderId,
	logger: Logger,
): ClearableModelFetcher {
	return createCachedModelFetcher<ApiKeyCredentials>({
		providerId,
		resolveUrl: (credentials) => `${litellmV1BaseUrl(credentials.baseUrl ?? "")}/model/info`,
		hasCredentials: (credentials) => Boolean(credentials.baseUrl?.trim()),
		createHeaders: (credentials): Record<string, string> =>
			credentials.apiKey
				? {
						"x-api-key": credentials.apiKey,
						Authorization: `Bearer ${credentials.apiKey}`,
					}
				: {},
		parseResponse: (data) => parseLitellmModelInfoResponse(data, providerId),
		fallbackModels: [],
		logger,
	});
}

/**
 * The shared LiteLLM chat-client factory. Module-level so both registrars set
 * the same value under the kind key `"litellm"` — re-registration is a no-op.
 */
const litellmClientFactory: ClientFactory = (credentials) => {
	if (credentials.type !== "apikey") {
		throw new Error(`LiteLLM provider requires API key credentials, got: ${credentials.type}`);
	}
	if (!credentials.baseUrl?.trim()) {
		throw new Error("LiteLLM provider requires a base URL");
	}
	const v1BaseUrl = litellmV1BaseUrl(credentials.baseUrl);
	// Two delegates against the same gateway, dispatched per request on the
	// resolved protocol. Both receive the normalized `/v1` API root (the
	// Anthropic SDK appends `/messages`; the OpenAI SDK appends
	// `/chat/completions` or `/responses` per `params.protocol`) and the same
	// key — LiteLLM accepts it in either header scheme. `customHeaders` go to
	// both: custom gateway entries rely on non-secret tenancy/routing headers,
	// which must flow regardless of route. An empty key stays delegate-owned
	// (the OpenAI client strips `Authorization` for keyless gateways).
	const anthropicClient = new AnthropicClient(
		credentials.apiKey,
		v1BaseUrl,
		credentials.customHeaders,
	);
	const openaiClient = new OpenAIClient({
		apiKey: credentials.apiKey,
		baseUrl: v1BaseUrl,
		apiMode: "completions",
		customHeaders: credentials.customHeaders,
	});
	// The catalog pipeline forwards the raw connection baseUrl as a
	// per-request routing override (params.baseUrl), which would clobber the
	// normalized constructor URL inside the delegates. Normalize it here so
	// every path into the proxy lands on `/v1` — litellm wire knowledge stays
	// in this module.
	return {
		chat: async (params) => {
			const routedParams = params.baseUrl
				? { ...params, baseUrl: litellmV1BaseUrl(params.baseUrl) }
				: params;
			const protocol = normalizeProtocol(params.protocol);
			// Undefined means "no routing decision was made" (declared
			// `models.custom` entries may omit `protocol`) — take the
			// Anthropic-shaped route, LiteLLM's own cross-provider default.
			if (protocol === undefined || protocol === "anthropic-messages") {
				return anthropicClient.chat(routedParams);
			}
			if (protocol === "openai-chat" || protocol === "openai-responses") {
				// `params.protocol` rides along; OpenAIClient selects the
				// endpoint (`/chat/completions` vs `/responses`) from it.
				return openaiClient.chat(routedParams);
			}
			throw new Error(
				`LiteLLM provider cannot route model "${params.model}" over protocol "${protocol}"`,
			);
		},
	};
};

/** Register the built-in `litellm` provider. */
export function registerLitellmProvider(registry: ProviderRegistry, logger: Logger): void {
	registry.registerModelFetcher("litellm", createLitellmModelFetcher("litellm", logger));
	registry.registerClientFactory("litellm", litellmClientFactory);
}

/**
 * Register a `providers.custom` entry with `type: "litellm"`.
 *
 * The model fetcher goes under the given custom provider id (independent
 * cache; discovered models carry that id). The client factory is registered
 * under the kind key `"litellm"` only — NOT under the custom id — so chat
 * resolution goes through `getClientForProviderOrKind`'s `clientKind`
 * fallback. Routing therefore follows the *current* catalog kind: an id-keyed
 * factory would keep serving the LiteLLM client after a live providers.json
 * reload changes the entry's `type`, because the registry has no unregister.
 */
export function registerCustomLitellmProvider(
	registry: ProviderRegistry,
	providerId: ResolvedProviderId,
	logger: Logger,
): void {
	registry.registerModelFetcher(providerId, createLitellmModelFetcher(providerId, logger));
	registry.registerClientFactory("litellm", litellmClientFactory);
}
