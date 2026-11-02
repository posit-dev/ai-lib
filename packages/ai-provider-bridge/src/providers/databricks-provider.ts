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
import { createOpenAICompatibleFetchMiddleware } from "../model-clients/openai-compat-fetch";
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

/** One entry of a Unity Catalog model-services list response (`view=FULL`). */
interface ModelService {
	/** `model-services/<catalog>.<schema>.<service>`. */
	name?: string;
	/** Gateway routes the service answers on, e.g. `"anthropic/v1/messages"`. */
	supported_api_types?: string[] | null;
}

interface ModelServicesPage {
	model_services?: ModelService[];
	next_page_token?: string;
}

const MODEL_SERVICE_PREFIX = "model-services/";
const SYSTEM_MODEL_PREFIX = "system.ai.";
const LEGACY_MODEL_PREFIX = "databricks-";

/**
 * Classifier identity for custom services. A `catalog.schema.service` name is
 * user-chosen and says nothing about the model behind it (a catalog named
 * `gpt-5` would otherwise match GPT-5's routes and limits), so custom services
 * get only their advertised routes and default limits. Must stay `""`, not
 * `undefined`: the classifier falls back with `??`, which keeps `""`.
 */
const UNKNOWN_MODEL_IDENTITY = "";

/** Bare upstream identity, used to match a service to its foundation-model entry. */
function bareModelName(name: string): string {
	return name.replace(/^system\.ai\./, "").replace(/^databricks-/, "");
}

/**
 * The name the gateway expects for a listed model id. System models are listed
 * under their legacy `databricks-<bare>` id so saved selections, conversations
 * and model rules keep matching, but the gateway needs the Unity Catalog name
 * (`system.ai.<bare>`): newer models reject the legacy one. Custom services are
 * listed under their Unity Catalog name already, which always has dots
 * (`catalog.schema.service`, even when the catalog starts with `databricks-`),
 * while system model names never do.
 */
function gatewayModelName(model: string): string {
	const bare = model.slice(LEGACY_MODEL_PREFIX.length);
	return model.startsWith(LEGACY_MODEL_PREFIX) && !bare.includes(".")
		? `${SYSTEM_MODEL_PREFIX}${bare}`
		: model;
}

/** Foundation-model display names keyed by bare model name (`claude-sonnet-4-6`). */
function foundationDisplayNames(data: unknown): Map<string, string> {
	const endpoints = (data as { endpoints?: ServingEndpoint[] }).endpoints ?? [];
	const names = new Map<string, string>();
	for (const endpoint of endpoints) {
		const displayName = endpoint.config?.served_entities?.[0]?.foundation_model?.display_name;
		if (endpoint.name && displayName) names.set(bareModelName(endpoint.name), displayName);
	}
	return names;
}

/**
 * Parse model services into routable models, stamped for the gateway surface.
 * System services (`system.ai.<bare>`) are listed as `databricks-<bare>` (see
 * {@link gatewayModelName}); custom services keep `catalog.schema.service`.
 *
 * Each service is handed to the classifier as a one-entity endpoint whose
 * `api_types` are the service's `supported_api_types`, so the classifier's
 * gateway gating works unchanged. Services with no chat or Responses route
 * (embeddings) are excluded by the classifier.
 */
function parseModelServices(
	services: readonly ModelService[],
	displayNames: ReadonlyMap<string, string>,
): ModelInfo[] {
	const models: ModelInfo[] = [];
	const seen = new Set<string>();
	for (const service of services) {
		const ucName = service.name?.startsWith(MODEL_SERVICE_PREFIX)
			? service.name.slice(MODEL_SERVICE_PREFIX.length)
			: service.name;
		if (!ucName || seen.has(ucName)) continue;
		seen.add(ucName);
		const isSystem = ucName.startsWith(SYSTEM_MODEL_PREFIX);
		const bare = bareModelName(ucName);
		const id = isSystem ? `${LEGACY_MODEL_PREFIX}${bare}` : ucName;
		const model = toModelInfo(
			{
				name: id,
				config: {
					served_entities: [
						{
							foundation_model: {
								name: isSystem ? id : UNKNOWN_MODEL_IDENTITY,
								display_name: isSystem ? (displayNames.get(bare) ?? bare) : ucName,
								api_types: service.supported_api_types ?? [],
								ai_gateway_v2_supported: true,
							},
						},
					],
				},
			},
			"gateway",
		);
		if (model) models.push(model);
	}
	return models;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

async function fetchModelList(
	url: string,
	headers: Record<string, string>,
	signal?: AbortSignal,
): Promise<unknown> {
	const response = await fetch(url, signal ? { headers, signal } : { headers });
	if (!response.ok) {
		throw new Error(`API returned ${response.status}`);
	}
	return response.json();
}

/** Upper bound on model-services pages, in case a workspace never stops returning tokens. */
const MAX_MODEL_SERVICE_PAGES = 50;

/** How long gateway discovery waits for the foundation-models list (display names only). */
const DISPLAY_NAMES_TIMEOUT_MS = 5_000;

/**
 * Every model service the caller can access, at metastore scope (no `parent`),
 * so custom `catalog.schema.service` routes are included. `view=FULL` is
 * required: the default view returns `supported_api_types: null` for custom
 * services. An empty page can still carry a token, so only a missing token
 * ends the list. A repeated token or the page cap stops early with a warning.
 */
async function fetchModelServices(
	host: string,
	headers: Record<string, string>,
	logger: Logger,
): Promise<ModelService[]> {
	const services: ModelService[] = [];
	const seenTokens = new Set<string>();
	let pageToken: string | undefined;
	for (let page = 0; page < MAX_MODEL_SERVICE_PAGES; page++) {
		const url = new URL(`${host}/api/2.1/unity-catalog/model-services`);
		url.searchParams.set("page_size", "100");
		url.searchParams.set("view", "FULL");
		if (pageToken) url.searchParams.set("page_token", pageToken);
		const data = (await fetchModelList(url.toString(), headers)) as ModelServicesPage;
		services.push(...(data.model_services ?? []));
		pageToken = data.next_page_token || undefined;
		if (!pageToken) return services;
		if (seenTokens.has(pageToken)) {
			logger.warn("[databricks] Model-services list repeated a page token; stopping early");
			return services;
		}
		seenTokens.add(pageToken);
	}
	logger.warn(
		`[databricks] Model-services list still had more pages after ${MAX_MODEL_SERVICE_PAGES}; some models may be missing`,
	);
	return services;
}

/**
 * Display names from the foundation-models list. Only labels depend on it, so
 * a failed or malformed response gives an empty map instead of emptying the
 * model list, and a slow one holds up the list for at most
 * {@link DISPLAY_NAMES_TIMEOUT_MS}.
 */
async function fetchDisplayNames(
	host: string,
	headers: Record<string, string>,
	logger: Logger,
): Promise<Map<string, string>> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DISPLAY_NAMES_TIMEOUT_MS);
	try {
		return foundationDisplayNames(
			await fetchModelList(
				`${host}/api/2.0/serving-endpoints:foundation-models`,
				headers,
				controller.signal,
			),
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.debug(`[databricks] Foundation-models list unavailable for display names: ${message}`);
		return new Map();
	} finally {
		clearTimeout(timer);
	}
}

/** Gateway discovery: model services, named from the foundation-models list where possible. */
async function fetchGatewayModels(
	host: string,
	headers: Record<string, string>,
	logger: Logger,
): Promise<ModelInfo[]> {
	const [services, displayNames] = await Promise.all([
		fetchModelServices(host, headers, logger),
		fetchDisplayNames(host, headers, logger),
	]);
	return parseModelServices(services, displayNames);
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
					? await fetchGatewayModels(host, headers, logger)
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
			customFetch: createOpenAICompatibleFetchMiddleware("Databricks", apiKey, customHeaders, {
				renameMaxTokens: false,
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
					// An override pointing at this workspace's own gateway still needs
					// the Unity Catalog name; any other URL (a proxy) gets the id as listed.
					return delegate.chat(
						params.baseUrl.startsWith(`${host}/ai-gateway/`)
							? { ...params, model: gatewayModelName(params.model) }
							: params,
					);
				}
				const surface = await surfaceState.ensureSurface(host, probeHeaders);
				return delegate.chat({
					...params,
					// Only the built-in gateway route gets the Unity Catalog name; a
					// pipeline-supplied base URL (above) may be any proxy.
					model: surface === "gateway" ? gatewayModelName(params.model) : params.model,
					baseUrl: databricksBaseUrl(surface, protocol, host),
				});
			},
		};
	});
}
