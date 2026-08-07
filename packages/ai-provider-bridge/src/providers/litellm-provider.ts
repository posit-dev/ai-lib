/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * LiteLLM provider
 *
 * Talks to a LiteLLM proxy through its unified `/v1/messages` endpoint
 * (Anthropic-shaped, alias-routed, cross-provider), so Anthropic-protocol
 * features — explicit cache breakpoints, thinking-block round-trips — survive
 * for Claude models behind the proxy (direct Anthropic, Bedrock, Vertex).
 * Non-Claude upstreams work through LiteLLM's translation layer but lose
 * reasoning continuity, so they get conservative capabilities and no thinking
 * effort levels.
 *
 * Model discovery uses `GET {baseUrl}/v1/model/info` (NOT `/v1/models`, which
 * is OpenAI-shaped and carries no metadata). Every `model_info` field is
 * optional in practice — local upstreams like Ollama report all-null metadata —
 * so parsing treats each field as best-effort.
 *
 * Credentials are `apikey` credentials: `baseUrl` is required (the proxy
 * address, e.g. `http://localhost:4000`); `apiKey` is optional — a proxy
 * without a master key needs no auth. The key is sent both as `x-api-key`
 * (what the Anthropic SDK sends on `/v1/messages`) and `Authorization: Bearer`
 * during discovery; LiteLLM accepts either scheme for virtual keys.
 */

import { getLitellmModelCapabilities } from "ai-config";

import { AnthropicClient } from "../model-clients/AnthropicClient";
import type { ApiKeyCredentials, Logger, ModelInfo } from "../types";
import { createCachedModelFetcher } from "./cached-model-fetcher";
import type { ProviderRegistry } from "./ProviderRegistry";

/** Conservative defaults for aliases whose upstream model is unrecognized. */
const LITELLM_DEFAULTS = {
	vendor: "litellm" as const,
	protocol: "anthropic-messages" as const,
	supportsTools: true,
	supportsImages: false,
	supportsToolResultImages: false,
	supportsWebSearch: false,
	maxInputTokens: 128_000,
	maxOutputTokens: 16_384,
	maxContextLength: 128_000,
} satisfies Partial<ModelInfo>;

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

function toModelInfo(entry: LitellmModelInfoEntry, alias: string): ModelInfo {
	const info = entry.model_info ?? {};
	const underlyingModel = entry.litellm_params?.model ?? "";

	// Claude detection tries the underlying model id first, then the alias
	// (admins often name aliases after the model, and some proxies omit
	// litellm_params entirely).
	const claudeCapabilities =
		getLitellmModelCapabilities(underlyingModel) ?? getLitellmModelCapabilities(alias);

	const model: ModelInfo = {
		id: alias,
		name: alias,
		providerId: "litellm",
		...LITELLM_DEFAULTS,
		...(claudeCapabilities
			? { vendor: "anthropic", supportsImages: true, ...claudeCapabilities }
			: {
					...(info.litellm_provider && { vendor: info.litellm_provider }),
					...(typeof info.max_input_tokens === "number" && {
						maxInputTokens: info.max_input_tokens,
						maxContextLength: info.max_input_tokens,
					}),
					...(typeof info.max_output_tokens === "number" && {
						maxOutputTokens: info.max_output_tokens,
					}),
					...(typeof info.supports_vision === "boolean" && {
						supportsImages: info.supports_vision,
					}),
				}),
	};
	return model;
}

/**
 * Parse a `/v1/model/info` response into chat-capable models.
 * Exported for tests.
 */
export function parseLitellmModelInfoResponse(data: unknown): ModelInfo[] {
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
		models.push(toModelInfo(entry, alias));
	}
	return models;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerLitellmProvider(registry: ProviderRegistry, logger: Logger): void {
	registry.registerModelFetcher(
		"litellm",
		createCachedModelFetcher<ApiKeyCredentials>({
			providerId: "litellm",
			resolveUrl: (credentials) => `${litellmV1BaseUrl(credentials.baseUrl ?? "")}/model/info`,
			hasCredentials: (credentials) => Boolean(credentials.baseUrl?.trim()),
			createHeaders: (credentials): Record<string, string> =>
				credentials.apiKey
					? {
							"x-api-key": credentials.apiKey,
							Authorization: `Bearer ${credentials.apiKey}`,
						}
					: {},
			parseResponse: parseLitellmModelInfoResponse,
			fallbackModels: [],
			logger,
		}),
	);

	registry.registerClientFactory("litellm", (credentials) => {
		if (credentials.type !== "apikey") {
			throw new Error(`LiteLLM provider requires API key credentials, got: ${credentials.type}`);
		}
		if (!credentials.baseUrl?.trim()) {
			throw new Error("LiteLLM provider requires a base URL");
		}
		return new AnthropicClient(
			credentials.apiKey,
			litellmV1BaseUrl(credentials.baseUrl),
			credentials.customHeaders,
		);
	});
}
