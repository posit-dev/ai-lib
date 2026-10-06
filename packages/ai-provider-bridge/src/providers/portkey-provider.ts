/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Portkey provider
 *
 * One gateway in front of many LLM services. What the stored API key *is* —
 * the key type, configured as `providers.portkey.keyType` or inferred from
 * the URL — selects one of three connection modes:
 *
 * - **Hosted** (`https://api.portkey.ai/v1`, Portkey key): the key is sent as
 *   `x-portkey-api-key`; models are Model Catalog ids of the form
 *   `@provider-slug/model`; discovery lists the integrated catalog.
 * - **Portkey gateway** (any other URL, key type `portkey`): a corporate proxy
 *   in front of hosted Portkey, or a Portkey hybrid gateway. The key is sent
 *   as `x-portkey-api-key` only (no `Authorization` / `x-api-key`); the base
 *   URL is used verbatim (users include `/v1` when their gateway needs it);
 *   no routing header is injected; either model-id form is accepted; and
 *   discovery requests `<url>/models` with Portkey auth.
 * - **Self-hosted OSS gateway** (any other URL, key type `upstream` — the
 *   default for non-canonical URLs): the gateway is stateless, so the key is
 *   one upstream's key sent in each delegate's native scheme; models are bare
 *   upstream ids declared by the user (`GET /v1/models` is broken on the OSS
 *   gateway — no discovery).
 *
 * The base URL is **required**: a defaulted URL would silently send the
 * secret somewhere the user never chose. Key-only credentials fail locally
 * with an instructive error before any request.
 *
 * Cross-field validation (URL, key type, key presence) is ai-config's
 * `checkPortkeyConnection`, shared with configure forms. Everything else —
 * mode selection, URL normalization, secret-header sanitization, auth wiring,
 * the chat/discovery header split, and gateway equivalence — is owned by
 * `resolvePortkeyConnection` and `samePortkeyGateway` here. The model fetcher
 * and the client factory both consume them; neither re-derives any of it.
 *
 * Each chat request routes over its natural wire protocol via a small
 * protocol-dispatching client (one Anthropic + one OpenAI delegate),
 * mirroring the landed LiteLLM dispatcher.
 */

import type { ResolvedProviderId } from "ai-config";
import {
	checkPortkeyConnection,
	classifyPortkeyModel,
	inferModelCapabilities,
	PORTKEY_HOSTED_BASE_URL,
} from "ai-config";

import { additiveHeaderRecord } from "../custom-headers";
import { AnthropicClient } from "../model-clients/AnthropicClient";
import { OpenAIClient } from "../model-clients/OpenAIClient";
import type { ApiKeyCredentials, Logger, ModelInfo } from "../types";
import { normalizeProtocol } from "../types";
import type { ClearableModelFetcher } from "./cached-model-fetcher";
import { createCachedModelFetcher } from "./cached-model-fetcher";
import type { ClientFactory, ProviderRegistry } from "./ProviderRegistry";

// ---------------------------------------------------------------------------
// Connection resolution — the single owner of Portkey's URL/mode/header rules
// ---------------------------------------------------------------------------

/**
 * Portkey credential headers. Filtered from `customHeaders` case-insensitively
 * on every path (the stored key is the only credential channel), and filtered
 * **provider-locally** — these names are Portkey credentials, not SDK-managed,
 * so they must not be added to the shared `custom-headers.ts` filter (that
 * would strip them from non-Portkey gateway configs that legitimately use
 * them as plain headers).
 */
const PORTKEY_SECRET_HEADER_NAMES: ReadonlySet<string> = new Set([
	"x-portkey-api-key",
	"x-portkey-virtual-key",
]);

/**
 * Portkey routing headers — a non-secret channel that scopes a request to an
 * upstream (`x-portkey-provider`) or a saved config (`x-portkey-config`).
 * They pass through on **chat only**; hosted discovery drops them, because a
 * routing header on `GET /v1/models` would scope or break the
 * integrated-catalog contract.
 */
const PORTKEY_ROUTING_HEADER_NAMES: ReadonlySet<string> = new Set([
	"x-portkey-provider",
	"x-portkey-config",
]);

/** HTTP header names are case-insensitive: filter by lowercased name. */
function withoutHeaders(
	headers: Record<string, string> | undefined,
	blockedLowercaseNames: ReadonlySet<string>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers ?? {}).filter(
			([name]) => !blockedLowercaseNames.has(name.toLowerCase()),
		),
	);
}

interface PortkeyRegistrationPolicy {
	/** Registry key and provider id stamped onto discovered models. */
	readonly providerId: ResolvedProviderId;
	/** Whether a base URL alone is enough to attempt connection resolution. */
	readonly apiKeyOptional: boolean;
}

/**
 * Normalize a Portkey gateway URL to its `/v1` API root
 * (`http://localhost:8787` → `http://localhost:8787/v1`), tolerating trailing
 * slashes and an existing `/v1` segment. Throws on unparseable input. Used by
 * the hosted and OSS modes; the Portkey-gateway mode keeps URLs verbatim.
 */
function normalizePortkeyGatewayUrl(rawUrl: string): string {
	let url: URL;
	try {
		url = new URL(rawUrl.trim());
	} catch {
		throw new Error(`Invalid Portkey base URL "${rawUrl}": not a valid URL`);
	}
	if (url.origin === "null") {
		throw new Error(`Invalid Portkey base URL "${rawUrl}": no host`);
	}
	const path = url.pathname.replace(/\/+$/, "");
	return `${url.origin}${path.endsWith("/v1") ? path : `${path}/v1`}`;
}

/**
 * A Portkey-gateway URL used as entered: never gains `/v1`. Only the
 * spelling is normalized, as {@link normalizePortkeyGatewayUrl} does — origin
 * case and trailing slashes. Throws on unparseable input.
 */
function verbatimGatewayUrl(rawUrl: string): string {
	const url = new URL(rawUrl.trim());
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * The URL a connection's mode sends requests to, for a raw base URL. Throws
 * on input the mode cannot normalize.
 */
function gatewayUrlForMode(mode: PortkeyConnection["mode"], rawUrl: string): string {
	return mode === "portkey-gateway"
		? verbatimGatewayUrl(rawUrl)
		: normalizePortkeyGatewayUrl(rawUrl);
}

/**
 * Gateway equivalence, mode-aware: whether `rawUrl` targets the same gateway
 * as `connection`. Hosted/OSS URLs are compared after `/v1` normalization,
 * Portkey-gateway URLs verbatim (trailing slashes trimmed) — so the raw
 * provider URL the catalog passes as a per-request `baseUrl` always matches
 * its own connection. Never throws: an unparseable URL is not the same
 * gateway.
 */
export function samePortkeyGateway(connection: PortkeyConnection, rawUrl: string): boolean {
	try {
		return gatewayUrlForMode(connection.mode, rawUrl) === connection.baseUrl;
	} catch {
		return false;
	}
}

/** The resolved Portkey connection: mode, gateway URL, and per-operation header material. */
export type PortkeyConnection =
	| {
			mode: "hosted";
			/** Normalized gateway API root (ends in `/v1`) — the sole request target. */
			baseUrl: string;
			/**
			 * Chat headers for both delegates: provider-owned auth
			 * (`x-portkey-api-key`) + sanitized `customHeaders` including routing
			 * headers.
			 */
			chatHeaders: Record<string, string>;
			/**
			 * Discovery headers: provider-owned auth + sanitized `customHeaders`
			 * **minus routing headers** (per-operation split).
			 */
			discoveryHeaders: Record<string, string>;
	  }
	| {
			mode: "portkey-gateway";
			/**
			 * The user's base URL, verbatim (trailing slashes trimmed) — the sole
			 * request target. Never gains `/v1`: a proxy may map its own path
			 * onto Portkey's `/v1`, and hybrid users copy `/v1` URLs as-is.
			 */
			baseUrl: string;
			/**
			 * Chat headers for both delegates: `x-portkey-api-key` + sanitized
			 * `customHeaders` including routing headers. No routing header is
			 * injected — routing is a config on the key or the gateway's job.
			 */
			chatHeaders: Record<string, string>;
			/** Discovery headers: Portkey auth + sanitized `customHeaders` minus routing headers. */
			discoveryHeaders: Record<string, string>;
	  }
	| {
			mode: "oss";
			/** Normalized gateway API root (ends in `/v1`) — the sole request target. */
			baseUrl: string;
			/** The stored key is this one upstream's key, sent in each delegate's native scheme. */
			upstreamKey: string;
			/**
			 * Chat headers for both delegates: sanitized `customHeaders` including
			 * routing headers, with the single-upstream default
			 * `x-portkey-provider: anthropic` injected when the user supplied no
			 * routing header. OSS has no discovery headers (no discovery).
			 */
			chatHeaders: Record<string, string>;
	  };

/**
 * Resolve a Portkey connection from credentials: validation, mode selection,
 * URL normalization, secret filtering, auth wiring, and the chat/discovery
 * header split — mode, secret meaning, headers, and destination are one
 * invariant, owned here.
 *
 * Validation is ai-config's `checkPortkeyConnection`, run on the effective
 * values (`credentials.portkey.keyType`, absent → inferred from the URL):
 * a missing/unparseable URL, the canonical hostname on any origin other than
 * exactly `https://api.portkey.ai`, an upstream key on the hosted origin, or
 * a missing Portkey key are local errors. Lookalike hosts
 * (`api.portkey.ai.example`) are ordinary gateways, and plain HTTP stays
 * valid for explicit self-hosted hosts like localhost.
 *
 * Mode selection: the canonical origin is hosted; otherwise key type
 * `portkey` is a Portkey gateway and `upstream` is OSS.
 *
 * Throws locally (no request is ever made) on invalid input. Chat surfaces
 * the throw to the user; discovery throws it inside `fetchFresh`, where the
 * cache wrapper catches and logs it and yields no models.
 */
export function resolvePortkeyConnection(credentials: ApiKeyCredentials): PortkeyConnection {
	const check = checkPortkeyConnection({
		baseUrl: credentials.baseUrl,
		keyType: credentials.portkey?.keyType,
		apiKeyPresent: Boolean(credentials.apiKey.trim()),
	});
	if (!check.ok) {
		throw new Error(check.message);
	}
	const sanitizedCustomHeaders = withoutHeaders(
		credentials.customHeaders,
		PORTKEY_SECRET_HEADER_NAMES,
	);

	if (check.keyType === "portkey") {
		// TODO(phase0-gate): auth-matrix probe — hosted auth is provisionally the
		// `x-portkey-api-key` header on every endpoint. A Portkey gateway takes
		// the same header (the customer's working proxy request sends only it).
		const authHeaders = { "x-portkey-api-key": credentials.apiKey };
		const chatHeaders = { ...sanitizedCustomHeaders, ...authHeaders };
		// Discovery bypasses the cached fetcher's additive-header merge, so the
		// shared SDK-managed filter (Authorization, x-api-key, …) is applied
		// here — the chat path gets the same filtering inside the delegates.
		const discoveryHeaders = additiveHeaderRecord(
			authHeaders,
			withoutHeaders(sanitizedCustomHeaders, PORTKEY_ROUTING_HEADER_NAMES),
		);
		return check.canonical
			? {
					mode: "hosted",
					baseUrl: normalizePortkeyGatewayUrl(check.baseUrl),
					chatHeaders,
					discoveryHeaders,
				}
			: {
					mode: "portkey-gateway",
					baseUrl: verbatimGatewayUrl(check.baseUrl),
					chatHeaders,
					discoveryHeaders,
				};
	}

	// OSS single-upstream: the connection serves one upstream. The user's
	// routing header wins when supplied; otherwise default to the Anthropic
	// passthrough upstream, matching the bare-Claude-id default route.
	// TODO(phase0-gate): confirm the OSS single-upstream shape against the
	// Phase 0 OSS probe results.
	const hasRoutingHeader = Object.keys(sanitizedCustomHeaders).some((name) =>
		PORTKEY_ROUTING_HEADER_NAMES.has(name.toLowerCase()),
	);
	return {
		mode: "oss",
		baseUrl: normalizePortkeyGatewayUrl(check.baseUrl),
		upstreamKey: credentials.apiKey,
		chatHeaders: hasRoutingHeader
			? sanitizedCustomHeaders
			: { ...sanitizedCustomHeaders, "x-portkey-provider": "anthropic" },
	};
}

// ---------------------------------------------------------------------------
// Model discovery (hosted catalog and Portkey gateways)
// ---------------------------------------------------------------------------

/** Hard cap on catalog size — a sane upper bound against a lying `total`. */
const MAX_DISCOVERED_MODELS = 10_000;
/** Hard bound on discovery requests, independent of what the server reports. */
const MAX_DISCOVERY_PAGES = 100;

interface PortkeyCatalogEntry {
	id: string;
	canonicalSlug?: string | null;
	provider?: string | null;
}

/** Parse one OpenAI-shaped `GET /v1/models` page (`data` array, optional `total`). */
function parsePortkeyModelsPage(data: unknown): {
	entries: PortkeyCatalogEntry[];
	total: number | undefined;
} {
	const body = (data ?? {}) as { data?: unknown; total?: unknown };
	const rawEntries = Array.isArray(body.data) ? body.data : [];
	const entries: PortkeyCatalogEntry[] = [];
	for (const raw of rawEntries) {
		const entry = (raw ?? {}) as { id?: unknown; canonical_slug?: unknown; provider?: unknown };
		if (typeof entry.id !== "string" || entry.id.length === 0) continue;
		entries.push({
			id: entry.id,
			canonicalSlug: typeof entry.canonical_slug === "string" ? entry.canonical_slug : undefined,
			provider: typeof entry.provider === "string" ? entry.provider : undefined,
		});
	}
	return { entries, total: typeof body.total === "number" ? body.total : undefined };
}

/**
 * Fetch the full hosted Model Catalog, stamping per-family protocol and
 * capabilities from `classifyPortkeyModel`'s decision object. The routed `id`
 * is always retained as the request model. Runs inside the cached fetcher's
 * `fetchFresh` seam, so a throw (including the missing-base-URL error, thrown
 * before any fetch) is caught by the wrapper, logged, and yields no models.
 * `signal` is the fetcher's discovery-deadline abort signal; it rides every
 * page request and stops pagination promptly between pages.
 */
async function fetchPortkeyCatalog(
	credentials: ApiKeyCredentials,
	providerId: ResolvedProviderId,
	logger: Logger,
	signal: AbortSignal,
): Promise<ModelInfo[]> {
	const connection = resolvePortkeyConnection(credentials);
	if (connection.mode === "oss") {
		// The OSS gateway's GET /v1/models is broken (400 — probed 2026-08-07
		// against 1.15.2) and the gateway is stateless anyway; self-hosters
		// declare models via `models.custom`. No fetch.
		return [];
	}

	const models: ModelInfo[] = [];
	const seenIds = new Set<string>();
	let received = 0;
	let pageLimit: number | undefined;
	for (let pageCount = 0; pageCount < MAX_DISCOVERY_PAGES; pageCount++) {
		// Stop paging promptly when the discovery deadline expired between pages.
		signal.throwIfAborted();
		// The resolver's base URL is the API root (hosted: normalized to end in
		// /v1; Portkey gateway: verbatim) — append only `/models` (never
		// `/v1/models`, which would double the segment).
		const url =
			received === 0
				? `${connection.baseUrl}/models`
				: `${connection.baseUrl}/models?limit=${pageLimit}&offset=${received}`;
		const response = await fetch(url, { headers: connection.discoveryHeaders, signal });
		if (!response.ok) {
			throw new Error(`Portkey model listing returned ${response.status}`);
		}
		const page = parsePortkeyModelsPage(await response.json());

		// No-progress guard: a page that adds no unseen ids (empty, or a server
		// that ignores `offset` and repeats a page) ends discovery — without
		// this, repeated pages would duplicate models and keep requesting until
		// the model bound.
		const newEntries = page.entries.filter((entry) => {
			if (seenIds.has(entry.id)) {
				return false;
			}
			seenIds.add(entry.id);
			return true;
		});
		if (newEntries.length === 0) {
			break;
		}

		for (const entry of newEntries) {
			const decision = classifyPortkeyModel({
				id: entry.id,
				canonicalSlug: entry.canonicalSlug,
				provider: entry.provider,
			});
			if (!decision.supported) {
				logger.debug(
					`[portkey] Excluding catalog model "${entry.id}" (${decision.family}): ${decision.exclusionReason}`,
				);
				continue;
			}
			const inferred = inferModelCapabilities("portkey", decision.capabilityModelId);
			models.push({
				// The routed catalog id is the exact request model; capabilities
				// come from the decision's underlying-model id.
				id: entry.id,
				name: entry.id,
				providerId,
				vendor: "anthropic",
				protocol: decision.protocol,
				...inferred.operational,
				capabilityFacts: {
					maxContextLength: inferred.facts.maxContextLength,
					maxInputTokens: inferred.facts.maxInputTokens,
					maxOutputTokens: inferred.facts.maxOutputTokens,
				},
			});
		}

		received += page.entries.length;
		pageLimit ??= page.entries.length;
		if (page.total === undefined || received >= page.total) {
			break;
		}
		if (received >= MAX_DISCOVERED_MODELS) {
			logger.warn(
				`[portkey] Model catalog reported total ${page.total}; stopping at the ${MAX_DISCOVERED_MODELS}-model bound`,
			);
			break;
		}
	}
	// A single oversized page could otherwise exceed the stated hard bound.
	return models.length > MAX_DISCOVERED_MODELS ? models.slice(0, MAX_DISCOVERED_MODELS) : models;
}

function createPortkeyModelFetcher(
	policy: PortkeyRegistrationPolicy,
	logger: Logger,
): ClearableModelFetcher {
	return createCachedModelFetcher<ApiKeyCredentials>({
		providerId: policy.providerId,
		// Built-in Portkey remains key-required. A custom registration may enter
		// connection resolution with only a base URL so keyless OSS/front-proxy
		// entries work. Mode validity remains wholly owned by
		// resolvePortkeyConnection: canonical hosted still rejects an empty key.
		hasCredentials: (credentials) =>
			policy.apiKeyOptional
				? Boolean(credentials.baseUrl?.trim())
				: Boolean(credentials.apiKey.trim()),
		fetchFresh: (credentials, signal) =>
			fetchPortkeyCatalog(credentials, policy.providerId, logger, signal),
		fallbackModels: [],
		logger,
	});
}

// ---------------------------------------------------------------------------
// Chat client (protocol-dispatching)
// ---------------------------------------------------------------------------

/**
 * Dummy native credential for hosted mode. Hosted authentication is the
 * provider-owned `x-portkey-api-key` header on both delegates; the delegates'
 * native schemes get this placeholder so the SDKs neither read ambient env
 * keys nor carry the real secret in a second scheme.
 *
 * TODO(phase0-gate): auth-matrix probe — confirm hosted endpoints ignore the
 * dummy `x-api-key` / `Authorization: Bearer`, and whether the OpenAI-shaped
 * endpoints accept `x-portkey-api-key` at all (vs requiring Bearer).
 */
const HOSTED_DUMMY_NATIVE_KEY = "portkey-uses-x-portkey-api-key";

/** Hosted catalog ids look like `@provider-slug/model`. */
const HOSTED_MODEL_ID_PATTERN = /^@[^/]+\/.+/;

/**
 * Mode-mismatch validation: hosted requires `@slug/model` catalog ids; OSS
 * requires bare upstream ids; a Portkey gateway accepts either (a config on
 * the key or the gateway may route bare ids). Model-id shape is validation
 * only — it never selects the mode.
 */
function validateModelIdForMode(connection: PortkeyConnection, model: string): void {
	if (connection.mode === "hosted" && !HOSTED_MODEL_ID_PATTERN.test(model)) {
		throw new Error(
			`Portkey hosted mode requires Model Catalog ids of the form "@provider-slug/model"; ` +
				`got "${model}". Bare upstream model ids are for self-hosted gateways (set the ` +
				`gateway's own base URL).`,
		);
	}
	if (connection.mode === "oss" && model.startsWith("@")) {
		throw new Error(
			`Portkey self-hosted mode requires bare upstream model ids; got catalog id "${model}". ` +
				`Catalog "@provider-slug/model" ids need a Portkey API key: use the hosted base URL ` +
				`${PORTKEY_HOSTED_BASE_URL}, or set the key type to Portkey for a proxy or hybrid gateway.`,
		);
	}
}

/**
 * The Portkey chat-client factory: a protocol-dispatching client that owns
 * one Anthropic and one OpenAI delegate against the resolved gateway.
 *
 * This deliberately **mirrors** the landed LiteLLM dispatcher
 * (litellm-provider.ts) rather than extracting a shared
 * `createProtocolDispatchingClient`: whether the per-mode credential
 * parameterization (LiteLLM sends one key in each delegate's native scheme;
 * hosted Portkey sends `x-portkey-api-key` on both delegates with dummy
 * native credentials) is clean enough to extract is a gated Phase 1 decision
 * — do not extract before the Phase 0 auth matrix settles it.
 */
const portkeyClientFactory: ClientFactory = (credentials) => {
	if (credentials.type !== "apikey") {
		throw new Error(`Portkey provider requires API key credentials, got: ${credentials.type}`);
	}
	// Throws the user-facing instructive error on key-only credentials.
	const connection = resolvePortkeyConnection(credentials);

	// Per-mode credential wiring (TODO(phase0-gate): the HOSTED half is
	// provisional pending the hosted auth-matrix probe):
	// - hosted: `x-portkey-api-key` rides in the sanitized chat headers on BOTH
	//   delegates; native credentials are dummies.
	// - OSS: the stored key is the upstream's key in each delegate's native
	//   scheme (x-api-key on /v1/messages, Bearer on the OpenAI-shaped routes).
	//   **Probe-confirmed** (OSS auth matrix, gateway 1.15.2, 2026-08-08 —
	//   plans/probe-findings-oss-2026-08-08.md): `Authorization: Bearer
	//   <upstream key>` works uniformly across endpoints and upstreams
	//   (anthropic, openai, gemini — the gateway re-maps to each upstream's
	//   native scheme), `x-api-key` is an anthropic-only alias, and Gemini's
	//   native `x-goog-api-key` is NOT read by the gateway. So the OpenAI
	//   delegate's Bearer wiring is the correct path for every non-Anthropic
	//   upstream including gemini, and the Anthropic delegate's `x-api-key` is
	//   confirmed for the anthropic upstream.
	// Both delegates receive the sanitized chat headers (routing headers
	// included — they are chat-scoped by the resolver's per-operation split).
	// - Portkey gateway: `x-portkey-api-key` only. Delegates get `apiKey: ""`,
	//   whose anonymous paths strip `x-api-key` and `Authorization` — a
	//   corporate gateway may read `Authorization` itself.
	const nativeKey =
		connection.mode === "hosted"
			? HOSTED_DUMMY_NATIVE_KEY
			: connection.mode === "portkey-gateway"
				? ""
				: connection.upstreamKey;
	const anthropicClient = new AnthropicClient(
		{ apiKey: nativeKey },
		connection.baseUrl,
		connection.chatHeaders,
	);
	const openaiClient = new OpenAIClient({
		apiKey: nativeKey,
		baseUrl: connection.baseUrl,
		apiMode: "completions",
		customHeaders: connection.chatHeaders,
	});

	return {
		chat: async (params) => {
			validateModelIdForMode(connection, params.model);

			// Same-gateway check: the resolver's URL is where every request goes.
			// The catalog pipeline lets per-model baseUrl/endpoints overrides reach
			// params.baseUrl, and the delegates trust params.baseUrl over their
			// constructor URL — forwarding an override would keep sending this
			// connection's credentials to an arbitrary host. Accept an override
			// only when it targets the same gateway; always delegate with the
			// resolver-owned URL.
			if (params.baseUrl !== undefined && !samePortkeyGateway(connection, params.baseUrl)) {
				throw new Error(
					`Portkey model "${params.model}" carries a base URL override "${params.baseUrl}" ` +
						`that does not match the connection's gateway "${connection.baseUrl}". ` +
						`Cross-gateway overrides are not supported — one Portkey connection is one ` +
						`gateway; configure a separate provider for the other URL.`,
				);
			}
			const routedParams = { ...params, baseUrl: connection.baseUrl };

			const protocol = normalizeProtocol(params.protocol);
			// Undefined means "no routing decision was made" (declared
			// `models.custom` entries may omit `protocol`) — take the
			// Anthropic-shaped route, the gateway's passthrough default.
			if (protocol === undefined || protocol === "anthropic-messages") {
				return anthropicClient.chat(routedParams);
			}
			if (protocol === "openai-chat" || protocol === "openai-responses") {
				// `params.protocol` rides along; OpenAIClient selects the endpoint
				// (`/chat/completions` vs `/responses`) from it.
				return openaiClient.chat(routedParams);
			}
			throw new Error(
				`Portkey provider cannot route model "${params.model}" over protocol "${protocol}"`,
			);
		},
	};
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register the built-in `portkey` provider. */
export function registerPortkeyProvider(registry: ProviderRegistry, logger: Logger): void {
	registry.registerModelFetcher(
		"portkey",
		createPortkeyModelFetcher({ providerId: "portkey", apiKeyOptional: false }, logger),
	);
	registry.registerClientFactory("portkey", portkeyClientFactory);
}

/**
 * Register a `providers.custom` entry with `type: "portkey"`.
 *
 * The fetcher is custom-id keyed for independent cache state and model
 * stamping. The factory is kind-keyed so live type changes resolve through
 * the catalog's current `clientKind`. Ordinary self-hosted Portkey performs
 * no runtime discovery; declared models are merged later by the catalog
 * consumer. Hosted discovery remains reachable only when the existing secure
 * credential backend supplies a non-empty key and is not a v1 product promise
 * for custom entries.
 */
export function registerCustomPortkeyProvider(
	registry: ProviderRegistry,
	providerId: ResolvedProviderId,
	logger: Logger,
): void {
	registry.registerModelFetcher(
		providerId,
		createPortkeyModelFetcher({ providerId, apiKeyOptional: true }, logger),
	);
	registry.registerClientFactory("portkey", portkeyClientFactory);
}
