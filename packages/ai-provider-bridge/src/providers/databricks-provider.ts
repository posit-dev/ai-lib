/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Databricks provider
 *
 * Routes through Unity AI Gateway when the workspace has it enabled (Beta,
 * account-level preview), falling back to classic Model Serving otherwise.
 * Gateway routing gives requests centralized governance: usage tracking,
 * inference tables, rate limits, and guardrails.
 *
 * Mode detection probes `GET {host}/api/ai-gateway/v2/endpoints` once per
 * workspace host (cached; cleared with the model cache so credential or
 * preview changes are picked up).
 *
 * - Gateway mode: models come from `GET {host}/api/2.0/serving-endpoints:foundation-models`,
 *   filtered to entities whose `foundation_model.api_types` include the
 *   MLflow chat-completions API. Chat goes to `{host}/ai-gateway/mlflow/v1/chat/completions`.
 * - Serving mode: models come from `GET {host}/api/2.0/serving-endpoints`,
 *   filtered to READY chat-capable endpoints (task `llm/v1/chat`, including
 *   external-model entities). Chat goes to `{host}/serving-endpoints/chat/completions`.
 *
 * Both surfaces are OpenAI-compatible with the endpoint name as the `model`
 * body parameter, so a single client serves both; only the base URL differs.
 *
 * Credentials are bearer-token `apikey` credentials: `apiKey` is a personal
 * access token or an OAuth access token (the host application decides which),
 * and `baseUrl` is the workspace host.
 */

import { additiveHeaderRecord } from "../custom-headers";
import { getDatabricksModelCapabilities } from "../model-capabilities/databricks-helpers";
import { createOpenAICompatibleFetch } from "../model-clients/openai-compat-fetch";
import { OpenAIClient } from "../model-clients/OpenAIClient";
import type { ApiKeyCredentials, Logger, ModelInfo, ProviderCredentials } from "../types";
import { normalizeDatabricksHost } from "../utils";
import type { ClearableModelFetcher } from "./cached-model-fetcher";
import type { ProviderRegistry } from "./ProviderRegistry";

const CACHE_TTL = 60 * 60 * 1000; // 60 minutes, matching createCachedModelFetcher

/** Conservative defaults for endpoints whose underlying model is unrecognized. */
const DATABRICKS_DEFAULTS = {
	vendor: "databricks" as const,
	protocol: "openai" as const,
	supportsTools: true,
	supportsImages: false,
	supportsToolResultImages: false,
	supportsWebSearch: false,
	maxInputTokens: 128_000,
	maxOutputTokens: 16_384,
	maxContextLength: 128_000,
} satisfies Partial<ModelInfo>;

/** Serving-endpoint task indicating an OpenAI-style chat interface. */
const CHAT_TASK = "llm/v1/chat";

/** Unity AI Gateway api_type indicating the MLflow chat-completions API. */
const GATEWAY_CHAT_API_TYPE = "mlflow/v1/chat/completions";

/** Path suffixes for the two chat surfaces (appended to the workspace host). */
const SERVING_CHAT_BASE_PATH = "/serving-endpoints";
const GATEWAY_CHAT_BASE_PATH = "/ai-gateway/mlflow/v1";

// ---------------------------------------------------------------------------
// Gateway availability probe (cached per workspace host)
// ---------------------------------------------------------------------------

/**
 * Per-host Unity AI Gateway availability. Shared between the model fetcher
 * and the chat client so both route consistently. Only definitive probe
 * results are cached; transient failures fall back to serving mode for that
 * attempt without poisoning the cache.
 */
const gatewayModeCache = new Map<string, boolean>();

/** Clear cached gateway availability (exported for tests; also cleared with the model cache). */
export function clearDatabricksGatewayModeCache(): void {
	gatewayModeCache.clear();
}

/**
 * Whether the workspace has Unity AI Gateway enabled.
 * 200 and 404/403 are definitive and cached; anything else (5xx, network
 * errors) defaults to serving mode for this attempt only.
 */
async function resolveGatewayMode(
	host: string,
	headers: Record<string, string>,
	logger: Logger,
): Promise<boolean> {
	const cached = gatewayModeCache.get(host);
	if (cached !== undefined) {
		return cached;
	}

	try {
		const response = await fetch(`${host}/api/ai-gateway/v2/endpoints?page_size=1`, { headers });
		if (response.ok) {
			logger.debug(`[databricks] Unity AI Gateway available; routing via gateway`);
			gatewayModeCache.set(host, true);
			return true;
		}
		if (response.status === 404 || response.status === 403) {
			logger.debug(
				`[databricks] Unity AI Gateway unavailable (${response.status}); routing via model serving`,
			);
			gatewayModeCache.set(host, false);
			return false;
		}
		logger.warn(
			`[databricks] Gateway probe returned ${response.status}; using model serving for this attempt`,
		);
		return false;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn(`[databricks] Gateway probe failed: ${message}; using model serving`);
		return false;
	}
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

interface FoundationModel {
	name?: string;
	display_name?: string;
	api_types?: string[];
	ai_gateway_v2_supported?: boolean;
}

interface ServedEntity {
	entity_name?: string;
	foundation_model?: FoundationModel;
	external_model?: { name?: string; provider?: string; task?: string };
}

interface ServingEndpoint {
	name?: string;
	task?: string;
	/** Requires endpoint-scoped OAuth authorization_details; excluded for now. */
	route_optimized?: boolean;
	state?: { ready?: string };
	config?: { served_entities?: ServedEntity[] };
}

/**
 * Whether a serving endpoint exposes a chat interface. Pay-per-token and
 * provisioned-throughput endpoints carry the task at the top level;
 * external-model endpoints carry it on each served entity.
 */
function isChatEndpoint(endpoint: ServingEndpoint): boolean {
	if (endpoint.task === CHAT_TASK) {
		return true;
	}
	const entities = endpoint.config?.served_entities ?? [];
	return entities.some((entity) => entity.external_model?.task === CHAT_TASK);
}

/**
 * Best-known identity of the model behind an endpoint, used for capability
 * inference. Falls back to the endpoint name (pay-per-token endpoint names
 * like `databricks-claude-sonnet-4-5` identify the model directly).
 */
function resolveModelIdentity(endpoint: ServingEndpoint): string {
	const entity = endpoint.config?.served_entities?.[0];
	return (
		entity?.foundation_model?.name ??
		entity?.external_model?.name ??
		entity?.entity_name ??
		endpoint.name ??
		""
	);
}

function toModelInfo(endpoint: ServingEndpoint): ModelInfo {
	const displayName = endpoint.config?.served_entities?.[0]?.foundation_model?.display_name;
	return {
		id: endpoint.name ?? "",
		name: displayName ?? endpoint.name ?? "",
		providerId: "databricks",
		...DATABRICKS_DEFAULTS,
		...getDatabricksModelCapabilities(resolveModelIdentity(endpoint)),
	};
}

/**
 * Parse a serving-endpoints list response into chat-capable models.
 * Exported for tests.
 */
export function parseServingEndpointsResponse(data: unknown): ModelInfo[] {
	const endpoints = (data as { endpoints?: ServingEndpoint[] }).endpoints ?? [];

	const models: ModelInfo[] = [];
	for (const endpoint of endpoints) {
		if (!endpoint.name) continue;
		if (endpoint.route_optimized === true) continue;
		if (endpoint.state?.ready !== "READY") continue;
		if (!isChatEndpoint(endpoint)) continue;
		models.push(toModelInfo(endpoint));
	}
	return models;
}

/**
 * Parse a foundation-models list response into gateway-chat-capable models.
 * Exported for tests.
 */
export function parseFoundationModelsResponse(data: unknown): ModelInfo[] {
	const endpoints = (data as { endpoints?: ServingEndpoint[] }).endpoints ?? [];

	const models: ModelInfo[] = [];
	for (const endpoint of endpoints) {
		if (!endpoint.name) continue;
		if (endpoint.route_optimized === true) continue;
		const entities = endpoint.config?.served_entities ?? [];
		const gatewayChatCapable = entities.some(
			(entity) =>
				entity.foundation_model?.ai_gateway_v2_supported === true &&
				(entity.foundation_model.api_types ?? []).includes(GATEWAY_CHAT_API_TYPE),
		);
		if (!gatewayChatCapable) continue;
		models.push(toModelInfo(endpoint));
	}
	return models;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

async function fetchModelList(url: string, headers: Record<string, string>): Promise<unknown> {
	const response = await fetch(url, { headers });
	if (!response.ok) {
		throw new Error(`API returned ${response.status}`);
	}
	return response.json();
}

function createDatabricksModelFetcher(logger: Logger): ClearableModelFetcher {
	let lastFetch = 0;
	let cachedModels: ModelInfo[] | null = null;

	const fetcher: ClearableModelFetcher = async (
		credentials: ProviderCredentials,
	): Promise<ModelInfo[]> => {
		const typed = credentials as ApiKeyCredentials;
		if (!typed.apiKey || !typed.baseUrl?.trim()) {
			logger.debug("[databricks] Missing apiKey or workspace host, returning no models");
			return [];
		}

		const now = Date.now();
		if (cachedModels && now - lastFetch < CACHE_TTL) {
			logger.debug("[databricks] Using cached models");
			return cachedModels;
		}

		const host = normalizeDatabricksHost(typed.baseUrl);
		const headers = additiveHeaderRecord(
			{ Authorization: `Bearer ${typed.apiKey}` },
			typed.customHeaders,
		);

		try {
			const useGateway = await resolveGatewayMode(host, headers, logger);
			const models = useGateway
				? parseFoundationModelsResponse(
						await fetchModelList(`${host}/api/2.0/serving-endpoints:foundation-models`, headers),
					)
				: parseServingEndpointsResponse(
						await fetchModelList(`${host}/api/2.0/serving-endpoints`, headers),
					);

			lastFetch = now;
			cachedModels = models;
			logger.info(
				`[databricks] Fetched ${models.length} chat models via ${useGateway ? "Unity AI Gateway" : "model serving"}`,
			);
			return models;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(`[databricks] Model fetch failed: ${message}`);
			return cachedModels ?? [];
		}
	};

	fetcher.clearCache = () => {
		cachedModels = null;
		lastFetch = 0;
		clearDatabricksGatewayModeCache();
	};

	return fetcher;
}

/**
 * Rewrite a model-serving chat URL to the Unity AI Gateway base path.
 * Exported for tests.
 */
export function rewriteServingUrlToGateway(url: string, host: string): string {
	const servingBase = `${host}${SERVING_CHAT_BASE_PATH}`;
	if (url.startsWith(servingBase)) {
		return `${host}${GATEWAY_CHAT_BASE_PATH}${url.slice(servingBase.length)}`;
	}
	return url;
}

/**
 * Wrap the OpenAI-compatible fetch so chat requests are re-routed to the
 * Unity AI Gateway when the workspace supports it. The client is constructed
 * against the model-serving base URL; this wrapper swaps the path prefix per
 * request based on the cached gateway probe.
 */
function createDatabricksChatFetch(
	host: string,
	apiKey: string,
	customHeaders: Record<string, string> | undefined,
	logger: Logger,
): typeof globalThis.fetch {
	const compatFetch = createOpenAICompatibleFetch("Databricks", apiKey, customHeaders);
	const probeHeaders = additiveHeaderRecord({ Authorization: `Bearer ${apiKey}` }, customHeaders);

	const fetchWithRouting = async (
		input: Parameters<typeof globalThis.fetch>[0],
		init?: Parameters<typeof globalThis.fetch>[1],
	): Promise<Response> => {
		const useGateway = await resolveGatewayMode(host, probeHeaders, logger);
		if (!useGateway) {
			return compatFetch(input, init);
		}
		if (typeof input === "string" || input instanceof URL) {
			return compatFetch(rewriteServingUrlToGateway(input.toString(), host), init);
		}
		return compatFetch(new Request(rewriteServingUrlToGateway(input.url, host), input), init);
	};

	return fetchWithRouting as typeof globalThis.fetch;
}

export function registerDatabricksProvider(registry: ProviderRegistry, logger: Logger): void {
	registry.registerModelFetcher("databricks", createDatabricksModelFetcher(logger));

	registry.registerClientFactory("databricks", (credentials) => {
		if (credentials.type !== "apikey") {
			throw new Error(`Databricks provider requires API key credentials, got: ${credentials.type}`);
		}
		if (!credentials.baseUrl?.trim()) {
			throw new Error("Databricks provider requires a workspace host (baseUrl)");
		}
		const host = normalizeDatabricksHost(credentials.baseUrl);
		// customHeaders are injected by the custom fetch wrapper.
		return new OpenAIClient(
			credentials.apiKey,
			`${host}${SERVING_CHAT_BASE_PATH}`,
			"completions",
			createDatabricksChatFetch(host, credentials.apiKey, credentials.customHeaders, logger),
		);
	});
}
