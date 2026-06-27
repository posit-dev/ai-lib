/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { getPositAiModelCapabilities } from "../model-capabilities/positai-helpers";
import { PositAiClient } from "../model-clients/PositAiClient";
import type {
	Logger,
	ModelInfo,
	OAuthCredentials,
	PositAiAuthMetadata,
	ProviderCredentials,
} from "../types";
import { isAgreementRequiredBody, joinPath } from "../utils";
import type { ProviderRegistry } from "./ProviderRegistry";

/**
 * When both a model and its successor are available, hide the older one.
 * Add entries here as new model versions are introduced.
 */
const modelSupersessions: Record<string, string> = {
	"claude-sonnet-4-5": "claude-sonnet-4-6",
	"claude-opus-4-5": "claude-opus-4-6",
};

function filterSupersededModels(models: ModelInfo[]): ModelInfo[] {
	const availableIds = new Set(models.map((m) => m.id));
	return models.filter((model) => {
		const supersededBy = modelSupersessions[model.id];
		return !supersededBy || !availableIds.has(supersededBy);
	});
}

/**
 * Response from the Posit AI /models endpoint
 */
interface PositAiModelsResponse {
	chat: Array<{
		id: string;
		display_name: string;
		endpoints: Array<{
			path: string;
			protocol: string;
		}>;
		max_context_length?: number;
	}>;
}

type PositAiModelFetcher = ((
	credentials: ProviderCredentials,
	metadata?: Record<string, unknown>,
) => Promise<ModelInfo[]>) & {
	clearCache?: () => void;
	getFetchState?: () => PositAiAuthMetadata | undefined;
};

/**
 * Map API protocol string from the Posit AI /models endpoint to the canonical
 * Protocol enum. The upstream gateway already returns values like
 * `"anthropic-messages"`, `"openai-chat"`, `"openai-responses"`.
 *
 * Only protocols that `PositAiClient` can actually handle are mapped; others
 * return `undefined` so the client falls back to model-id inference. In
 * particular, `"openai-responses"` is NOT mapped here because the client
 * uses `@ai-sdk/openai-compatible` which has no Responses API path — surfacing
 * the value would let the model be selected but fail at chat time.
 */
function mapProtocol(apiProtocol: string): "anthropic-messages" | "openai-chat" | undefined {
	if (apiProtocol === "anthropic-messages") return "anthropic-messages";
	if (apiProtocol === "openai-chat") return "openai-chat";
	return undefined;
}

/**
 * Infer vendor from the raw API protocol string (not the mapped one).
 * This ensures vendor is correctly derived even when `mapProtocol()` returns
 * `undefined` for a protocol the client can't handle yet (e.g.
 * `"openai-responses"` — still an OpenAI-family model for display purposes).
 */
function inferVendor(apiProtocol: string | undefined): string {
	if (!apiProtocol) return "unknown";
	if (apiProtocol.startsWith("anthropic")) return "anthropic";
	if (apiProtocol.startsWith("openai")) return "openai";
	return "unknown";
}

export function registerPositAiProvider(
	registry: ProviderRegistry,
	baseUrl: string | (() => string),
	userAgent: string = "Posit Assistant/unknown",
	logger: Logger,
): void {
	const resolveBaseUrl = typeof baseUrl === "function" ? baseUrl : () => baseUrl;
	const TTL = 60 * 60 * 1000;
	let lastFetch = 0;
	let cachedModels: ModelInfo[] | null = null;
	let lastFetchState: PositAiAuthMetadata | undefined;

	const fetcher: PositAiModelFetcher = async (
		credentials: ProviderCredentials,
	): Promise<ModelInfo[]> => {
		const logPrefix = "[positai]";
		const oauthCredentials = credentials as OAuthCredentials;
		if (!oauthCredentials.accessToken) {
			lastFetchState = undefined;
			return [];
		}

		const now = Date.now();
		if (cachedModels && now - lastFetch < TTL) {
			logger.debug(`${logPrefix} Using cached models`);
			return cachedModels;
		}

		try {
			logger.debug(`${logPrefix} Fetching models from API`);
			const response = await fetch(joinPath(resolveBaseUrl(), "/models"), {
				headers: {
					Authorization: `Bearer ${oauthCredentials.accessToken}`,
				},
			});

			if (!response.ok) {
				const body = await response.text().catch(() => undefined);
				if (response.status === 403 && isAgreementRequiredBody(body)) {
					lastFetchState = {
						modelFetchState: "agreement_pending",
						modelFetchStatusCode: response.status,
					};
					logger.warn(
						`${logPrefix} API fetch failed: API returned 403 agreement pending, using fallback`,
					);
					return [];
				}

				lastFetchState = {
					modelFetchState: "error",
					modelFetchStatusCode: response.status,
				};
				throw new Error(`API returned ${response.status}`);
			}

			const data = (await response.json()) as PositAiModelsResponse;
			logger.debug(`[positai] Models endpoint response: ${JSON.stringify(data)}`);

			if (!data.chat || !Array.isArray(data.chat)) {
				lastFetchState = {
					modelFetchState: "error",
				};
				logger.warn("[positai] Unexpected response format, missing chat array");
				return [];
			}

			const freshModels = filterSupersededModels(
				data.chat.map((model) => {
					const apiProtocol = model.endpoints?.[0]?.protocol;
					const protocol = apiProtocol ? mapProtocol(apiProtocol) : undefined;
					const vendor = inferVendor(apiProtocol);
					const capabilities = getPositAiModelCapabilities(model.id);

					return {
						id: model.id,
						name: model.display_name,
						providerId: "positai",
						vendor,
						protocol,
						supportsTools: true,
						supportsImages: true,
						supportsToolResultImages: true,
						supportedInputMediaTypes: [
							"image/png",
							"image/jpeg",
							"image/gif",
							"image/webp",
							"application/pdf",
						],
						maxOutputTokens: 16000,
						...capabilities,
						// API-sourced context length takes precedence over inferred capabilities
						maxContextLength: model.max_context_length ?? capabilities?.maxContextLength ?? 200000,
						maxInputTokens: model.max_context_length ?? capabilities?.maxInputTokens ?? 200000,
						// Only Anthropic-protocol models support provider-native web search
						supportsWebSearch: protocol === "anthropic-messages",
					};
				}),
			);

			lastFetch = now;
			cachedModels = freshModels;
			lastFetchState = {
				modelFetchState: "ok",
			};
			logger.info(`${logPrefix} Fetched ${freshModels.length} models from API`);
			return freshModels;
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.warn(`${logPrefix} API fetch failed: ${errorMsg}, using fallback`);
			if (cachedModels) {
				logger.debug(`${logPrefix} Returning stale cached models`);
				lastFetchState = {
					modelFetchState: "ok",
				};
				return cachedModels;
			}
			return [];
		}
	};

	fetcher.clearCache = () => {
		cachedModels = null;
		lastFetch = 0;
		lastFetchState = undefined;
	};
	fetcher.getFetchState = () => lastFetchState;

	registry.registerModelFetcher("positai", fetcher);

	registry.registerClientFactory("positai", (credentials) => {
		if (credentials.type !== "oauth") {
			throw new Error(`Posit AI provider requires OAuth credentials, got: ${credentials.type}`);
		}
		return new PositAiClient(credentials.accessToken, resolveBaseUrl(), userAgent, logger);
	});
}
