/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Databricks provider
 *
 * Databricks fronts many vendors behind one workspace, on one of two
 * **surfaces**:
 *
 * - **Serving** — classic Model Serving (`{host}/serving-endpoints/...`).
 * - **Gateway** — Unity AI Gateway (`{host}/ai-gateway/...`), which adds
 *   centralized governance: usage tracking, inference tables, rate limits,
 *   guardrails.
 *
 * Besides the universal OpenAI-compatible chat surface, both expose **native
 * passthrough APIs** per vendor (Anthropic Messages, OpenAI Responses, Gemini
 * generateContent). Native routes recover what chat completions loses —
 * thinking controls, Claude cache breakpoints and thinking-block round-trips
 * (input media types stay masked to images on every route: Databricks
 * documents native passthrough inputs as text/image only) — so each
 * discovered endpoint is stamped with the protocol it
 * will be routed over (`inferDatabricksModelProfile` in ai-config is the single
 * source of truth for routing eligibility *and* the capabilities that protocol
 * offers). The catalog pipeline carries the stamp into each chat request as
 * `params.protocol` (precedence: user override > connection `protocol` >
 * stamp), and this module's client factory dispatches per request to a
 * protocol-specific delegate. Non-native gateway endpoints prefer unified
 * MLflow Responses when advertised and otherwise carry an explicit
 * `openai-chat` fallback stamp.
 *
 * **One pinned surface decision** ({@link createSurfaceState}) owns both
 * stamping and routing. The first caller — discovery *or* chat, since the
 * registry lets a host create a client and chat without ever fetching models —
 * probes `GET {host}/api/ai-gateway/v2/endpoints` and pins the answer for that
 * workspace host; concurrent callers share the in-flight probe. A probe failure
 * pins `serving` too: a "retry next time" fallback would let discovery stamp
 * serving-qualified protocols that a later chat routes down gateway paths. The
 * pin is per registration and is released together with the model cache by
 * `clearCache()`.
 *
 * Surface × protocol → base URL lives in one seam
 * ({@link databricksBaseUrl}), whose values are **AI-SDK bases**: the Vercel
 * SDKs append only their operation path (`/messages`,
 * `/models/{id}:generateContent`), so the version segment (`/v1`, `/v1beta`)
 * belongs in our base. When the pipeline already supplied `params.baseUrl` it
 * is trusted verbatim and no probe is needed.
 *
 * Credentials are bearer-token `apikey` credentials: `apiKey` is a personal
 * access token or an OAuth access token (the host application decides which),
 * and `baseUrl` is the workspace host.
 */

import type { DatabricksServedEntityInput, DatabricksSurface } from "ai-config";
import { inferDatabricksModelProfile } from "ai-config";

import { additiveHeaderRecord } from "../custom-headers";
import { AnthropicClient } from "../model-clients/AnthropicClient";
import { GeminiGenerateContentClient } from "../model-clients/GeminiGenerateContentClient";
import type { ModelClient } from "../model-clients/ModelClient";
import { createOpenAICompatibleFetch } from "../model-clients/openai-compat-fetch";
import { OpenAIClient } from "../model-clients/OpenAIClient";
import type { ApiKeyCredentials, Logger, ModelInfo, Protocol, ProviderCredentials } from "../types";
import { normalizeProtocol } from "../types";
import { normalizeDatabricksHost } from "../utils";
import type { ClearableModelFetcher } from "./cached-model-fetcher";
import type { ProviderRegistry } from "./ProviderRegistry";

const CACHE_TTL = 60 * 60 * 1000; // 60 minutes, matching createCachedModelFetcher

// ---------------------------------------------------------------------------
// Pinned surface decision
// ---------------------------------------------------------------------------

/**
 * The pinned surface decision for one provider registration.
 *
 * `ensureSurface` is single-flight per workspace host: the first caller probes,
 * every concurrent caller awaits the same promise, and the answer is pinned
 * until {@link SurfaceState.clear}. Discovery and chat therefore always agree,
 * whichever ran first.
 */
interface SurfaceState {
	ensureSurface(host: string, headers: Record<string, string>): Promise<DatabricksSurface>;
	clear(): void;
}

/**
 * Probe Unity AI Gateway availability. Never rejects: 200 means gateway,
 * 404/403 means serving, and anything else (5xx, network error) means serving
 * as well — the caller pins whatever comes back, so an ambiguous answer must
 * still be a usable one.
 */
async function probeSurface(
	host: string,
	headers: Record<string, string>,
	logger: Logger,
): Promise<DatabricksSurface> {
	try {
		const response = await fetch(`${host}/api/ai-gateway/v2/endpoints?page_size=1`, { headers });
		if (response.ok) {
			logger.debug(`[databricks] Unity AI Gateway available; routing via gateway`);
			return "gateway";
		}
		if (response.status === 404 || response.status === 403) {
			logger.debug(
				`[databricks] Unity AI Gateway unavailable (${response.status}); routing via model serving`,
			);
			return "serving";
		}
		logger.warn(
			`[databricks] Gateway probe returned ${response.status}; pinning model serving until the model cache is cleared`,
		);
		return "serving";
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn(
			`[databricks] Gateway probe failed: ${message}; pinning model serving until the model cache is cleared`,
		);
		return "serving";
	}
}

/** Create the per-registration, per-host pinned surface state. */
function createSurfaceState(logger: Logger): SurfaceState {
	// Generation guard: a probe that was already in flight when clear() ran
	// (e.g. issued under since-replaced credentials) must not commit its result
	// afterwards — it could re-pin a stale surface or evict a newer in-flight
	// probe. Results are committed only when the generation is unchanged.
	let generation = 0;
	const pinned = new Map<string, DatabricksSurface>();
	const inFlight = new Map<string, Promise<DatabricksSurface>>();

	return {
		ensureSurface(host, headers) {
			const decided = pinned.get(host);
			if (decided !== undefined) {
				return Promise.resolve(decided);
			}
			const existing = inFlight.get(host);
			if (existing !== undefined) {
				return existing;
			}
			const startedIn = generation;
			const probe = probeSurface(host, headers, logger).then((surface) => {
				if (generation === startedIn) {
					pinned.set(host, surface);
					inFlight.delete(host);
				}
				return surface;
			});
			inFlight.set(host, probe);
			return probe;
		},
		clear() {
			generation += 1;
			pinned.clear();
			inFlight.clear();
		},
	};
}

// ---------------------------------------------------------------------------
// Route seam: surface × protocol → AI-SDK base URL
// ---------------------------------------------------------------------------

/**
 * The base URL a delegate must be given for one surface and protocol.
 *
 * These are **AI-SDK bases**, not the vendor-SDK bases Databricks' docs show:
 * `@ai-sdk/anthropic` appends only `/messages` and `@ai-sdk/google` appends
 * `/models/{id}:generateContent`, so the version segment lives here.
 *
 */
function databricksBaseUrl(
	surface: DatabricksSurface,
	protocol: Protocol | undefined,
	host: string,
): string {
	const gateway = surface === "gateway";
	switch (protocol) {
		case "anthropic-messages":
			return gateway ? `${host}/ai-gateway/anthropic/v1` : `${host}/serving-endpoints/anthropic/v1`;
		case "openai-responses":
			return gateway ? `${host}/ai-gateway/openai/v1` : `${host}/serving-endpoints`;
		case "mlflow-responses":
			// The gateway's unified Responses API. Only stamped on the gateway
			// surface — classic serving has no unified Responses route, so the
			// classifier degrades those endpoints to `openai-chat` instead.
			return `${host}/ai-gateway/mlflow/v1`;
		case "google-generative":
			return gateway
				? `${host}/ai-gateway/gemini/v1beta`
				: `${host}/serving-endpoints/gemini/v1beta`;
		default:
			// Chat completions, the universal fallback (and the route an absent
			// protocol takes).
			return gateway ? `${host}/ai-gateway/mlflow/v1` : `${host}/serving-endpoints`;
	}
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/** Serving-endpoint task indicating an OpenAI-style chat interface. */
const CHAT_TASK = "llm/v1/chat";

/**
 * One entry of a serving-endpoints (or foundation-models) list response. The
 * served-entity shape is the classifier's input type, so the discovery response
 * and the classification rules cannot drift apart.
 */
interface ServingEndpoint {
	name?: string;
	task?: string;
	/** Requires endpoint-scoped OAuth authorization_details; excluded for now. */
	route_optimized?: boolean;
	state?: { ready?: string };
	config?: { served_entities?: DatabricksServedEntityInput[] };
}

/**
 * Whether a serving endpoint exposes a chat interface at all. Pay-per-token and
 * provisioned-throughput endpoints carry the task at the top level;
 * external-model endpoints carry it on each served entity. Non-chat endpoints
 * (embeddings, completions, feature serving) have no route on either surface —
 * the classifier's fallback assumes the chat route exists, so they are filtered
 * out before classification. The gateway surface advertises no task and relies
 * on the classifier's `api_types` gating instead.
 */
function isChatEndpoint(endpoint: ServingEndpoint): boolean {
	if (endpoint.task === CHAT_TASK) {
		return true;
	}
	const entities = endpoint.config?.served_entities ?? [];
	return entities.some((entity) => entity.external_model?.task === CHAT_TASK);
}

/**
 * Classify one endpoint into a stamped model, or `undefined` when the pinned
 * surface offers it no route at all.
 */
function toModelInfo(endpoint: ServingEndpoint, surface: DatabricksSurface): ModelInfo | undefined {
	const endpointName = endpoint.name ?? "";
	const servedEntities = endpoint.config?.served_entities ?? [];
	const profile = inferDatabricksModelProfile({
		surface,
		endpointName,
		task: endpoint.task,
		servedEntities,
	});
	if (profile.excluded) {
		return undefined;
	}
	const displayName = servedEntities[0]?.foundation_model?.display_name;
	return {
		id: endpointName,
		name: displayName ?? endpointName,
		providerId: "databricks",
		...profile.capabilities,
		vendor: profile.vendor,
		protocol: profile.protocol,
	};
}

/**
 * Parse a serving-endpoints list response into routable models, stamped for the
 * serving surface.
 */
function parseServingEndpointsResponse(data: unknown): ModelInfo[] {
	const endpoints = (data as { endpoints?: ServingEndpoint[] }).endpoints ?? [];

	const models: ModelInfo[] = [];
	for (const endpoint of endpoints) {
		if (!endpoint.name) continue;
		if (endpoint.route_optimized === true) continue;
		if (endpoint.state?.ready !== "READY") continue;
		if (!isChatEndpoint(endpoint)) continue;
		const model = toModelInfo(endpoint, "serving");
		if (model) models.push(model);
	}
	return models;
}

/**
 * Parse a foundation-models list response into routable models, stamped for the
 * gateway surface. Route availability is not filtered here: the classifier
 * excludes endpoints whose entities cannot all serve any supported gateway
 * route.
 */
function parseFoundationModelsResponse(data: unknown): ModelInfo[] {
	const endpoints = (data as { endpoints?: ServingEndpoint[] }).endpoints ?? [];

	const models: ModelInfo[] = [];
	for (const endpoint of endpoints) {
		if (!endpoint.name) continue;
		if (endpoint.route_optimized === true) continue;
		const model = toModelInfo(endpoint, "gateway");
		if (model) models.push(model);
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

function createDatabricksModelFetcher(
	surfaceState: SurfaceState,
	logger: Logger,
): ClearableModelFetcher {
	let lastFetch = 0;
	let cachedModels: ModelInfo[] | null = null;
	// Same generation guard as the surface state: a fetch spanning clearCache()
	// may still answer its own caller, but must not repopulate the cache.
	let generation = 0;

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
			const startedIn = generation;
			const surface = await surfaceState.ensureSurface(host, headers);
			const models =
				surface === "gateway"
					? parseFoundationModelsResponse(
							await fetchModelList(`${host}/api/2.0/serving-endpoints:foundation-models`, headers),
						)
					: parseServingEndpointsResponse(
							await fetchModelList(`${host}/api/2.0/serving-endpoints`, headers),
						);

			if (generation === startedIn) {
				lastFetch = now;
				cachedModels = models;
			}
			logger.info(
				`[databricks] Fetched ${models.length} chat models via ${surface === "gateway" ? "Unity AI Gateway" : "model serving"}`,
			);
			return models;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(`[databricks] Model fetch failed: ${message}`);
			return cachedModels ?? [];
		}
	};

	fetcher.clearCache = () => {
		generation += 1;
		cachedModels = null;
		lastFetch = 0;
		// The surface pin and the model cache are released together: stamps and
		// routes must always come from the same decision.
		surfaceState.clear();
	};

	return fetcher;
}

export function registerDatabricksProvider(registry: ProviderRegistry, logger: Logger): void {
	// One surface decision per registration, shared by discovery and chat.
	const surfaceState = createSurfaceState(logger);

	registry.registerModelFetcher("databricks", createDatabricksModelFetcher(surfaceState, logger));

	registry.registerClientFactory("databricks", (credentials) => {
		if (credentials.type !== "apikey") {
			throw new Error(`Databricks provider requires API key credentials, got: ${credentials.type}`);
		}
		if (!credentials.baseUrl?.trim()) {
			throw new Error("Databricks provider requires a workspace host (baseUrl)");
		}
		const host = normalizeDatabricksHost(credentials.baseUrl);
		const { apiKey, customHeaders } = credentials;
		const probeHeaders = additiveHeaderRecord({ Authorization: `Bearer ${apiKey}` }, customHeaders);

		// Three delegates against the same workspace, dispatched per request on
		// the resolved protocol. Each is constructed without a base URL — routing
		// is a per-request decision (`params.baseUrl`), because the surface may
		// not be pinned yet when the client is created. `customHeaders` go to all
		// three: enterprise workspaces rely on non-secret routing headers such as
		// `x-databricks-use-coding-agent-mode`, which must flow on every route
		// (each delegate strips auth-bearing names itself).
		//
		// Both native vendor surfaces authenticate with `Authorization: Bearer`,
		// not the vendors' own key headers.
		const anthropicClient = new AnthropicClient({ authToken: apiKey }, undefined, customHeaders);
		// One OpenAI delegate for both OpenAI-shaped routes: it selects
		// `/chat/completions` vs `/responses` from `params.protocol`. The
		// OpenAI-compatible fetch stays on this path for Databricks' chat-surface
		// quirks (parameter renames, malformed SSE chunks) and to carry
		// `customHeaders`; it no longer rewrites URLs — routing comes from the
		// base URL alone.
		const openaiClient = new OpenAIClient({
			apiKey,
			apiMode: "completions",
			// Databricks strict-decodes the Chat Completions body: it requires
			// `max_tokens` and answers 400 `unknown field "max_completion_tokens"`,
			// so the shared wrapper's rename must be turned off here.
			customFetch: (delegate) =>
				createOpenAICompatibleFetch("Databricks", apiKey, customHeaders, {
					renameMaxTokens: false,
					fetch: delegate,
				}),
		});
		const geminiClient = new GeminiGenerateContentClient(
			{ authToken: apiKey },
			undefined,
			customHeaders,
		);

		const selectDelegate = (model: string, protocol: Protocol | undefined): ModelClient => {
			switch (protocol) {
				case "anthropic-messages":
					return anthropicClient;
				// `undefined` means no routing decision was made (a declared
				// `models.custom` entry may omit `protocol`) — chat completions is
				// the universal fallback on both surfaces.
				case undefined:
				case "openai-chat":
				case "openai-responses":
				case "mlflow-responses":
					return openaiClient;
				case "google-generative":
					return geminiClient;
				default:
					throw new Error(
						`Databricks provider cannot route model "${model}" over protocol "${protocol}"`,
					);
			}
		};

		return {
			chat: async (params) => {
				const protocol = normalizeProtocol(params.protocol);
				const delegate = selectDelegate(params.model, protocol);
				// A base URL from the pipeline is already fully resolved (user
				// override > `endpoints[protocol]` > discovery > provider baseUrl)
				// and never carries the workspace host, which lives in credentials —
				// so it is trusted verbatim, and no probe is needed.
				if (params.baseUrl) {
					return delegate.chat(params);
				}
				const surface = await surfaceState.ensureSurface(host, probeHeaders);
				return delegate.chat({
					...params,
					baseUrl: databricksBaseUrl(surface, protocol, host),
				});
			},
		};
	});
}
