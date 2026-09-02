/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Portkey provider
 *
 * One gateway in front of many LLM services, with two deployment shapes that
 * change what the stored API key *is*:
 *
 * - **Hosted Portkey** (`https://api.portkey.ai/v1`): the key is a Portkey
 *   API key sent as `x-portkey-api-key`; models are Model Catalog ids of the
 *   form `@provider-slug/model`; discovery lists the integrated catalog.
 * - **Self-hosted OSS gateway** (any other base URL): the gateway is
 *   stateless, so the key is one upstream's key sent in each delegate's
 *   native scheme; models are bare upstream ids declared by the user
 *   (`GET /v1/models` is broken on the OSS gateway — no discovery).
 *
 * Because the base URL determines the key's meaning, it is **required**: a
 * defaulted URL would silently reinterpret the secret (e.g. send a
 * self-hoster's Anthropic key to hosted Portkey). Key-only credentials fail
 * locally with an instructive error before any request.
 *
 * `resolvePortkeyConnection` is the single owner of every connection rule —
 * required-URL validation, hosted-vs-OSS classification, `/v1` normalization,
 * secret-header sanitization, auth wiring, and the chat/discovery header
 * split. The model fetcher and the client factory both consume it; neither
 * re-derives any of it.
 *
 * Each chat request routes over its natural wire protocol via a small
 * protocol-dispatching client (one Anthropic + one OpenAI delegate),
 * mirroring the landed LiteLLM dispatcher.
 */

import type { ResolvedProviderId } from "ai-config";
import {
	classifyPortkeyModel,
	inferModelCapabilities,
	PORTKEY_HOST,
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

const MISSING_BASE_URL_MESSAGE =
	"The Portkey provider requires a base URL: it selects the deployment mode and what the " +
	`API key means (hosted Portkey API key vs a self-hosted gateway's upstream key). Set the ` +
	`PORTKEY_BASE_URL environment variable (hosted: ${PORTKEY_HOSTED_BASE_URL}) or enter a ` +
	"base URL in the Portkey configure form.";

const CANONICAL_PORTKEY_HOSTNAME = new URL(PORTKEY_HOST).hostname;

interface PortkeyRegistrationPolicy {
	/** Registry key and provider id stamped onto discovered models. */
	readonly providerId: ResolvedProviderId;
	/** Whether a base URL alone is enough to attempt connection resolution. */
	readonly apiKeyOptional: boolean;
}

/**
 * Normalize a Portkey gateway URL to its `/v1` API root
 * (`http://localhost:8787` → `http://localhost:8787/v1`), tolerating trailing
 * slashes and an existing `/v1` segment. Throws on unparseable input.
 *
 * Also the equivalence relation for the dispatcher's same-gateway check: two
 * URLs target the same gateway iff they normalize to the same string.
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
 * Resolve a Portkey connection from credentials: required-URL validation,
 * hosted-vs-OSS classification, `/v1` normalization, secret filtering, auth
 * wiring, and the chat/discovery header split — mode, secret meaning,
 * headers, and destination are one invariant, owned here.
 *
 * Hosted classification is **exact-canonical-HTTPS-origin** only
 * (`https://api.portkey.ai`, default port). The canonical hostname under any
 * other scheme or port is a local error — `http://api.portkey.ai` has no safe
 * classification (hosted would put the Portkey key on plaintext; OSS would
 * drop it into upstream-native headers on plaintext). Lookalike hosts
 * (`api.portkey.ai.example`) classify as OSS, and plain HTTP stays valid for
 * explicit self-hosted hosts like localhost.
 *
 * Throws locally (no request is ever made) on a missing, invalid, or
 * hosted-lookalike-hazard URL. Chat surfaces the throw to the user;
 * discovery throws it inside `fetchFresh`, where the cache wrapper catches
 * and logs it and yields no models.
 */
export function resolvePortkeyConnection(credentials: ApiKeyCredentials): PortkeyConnection {
	const rawBaseUrl = credentials.baseUrl?.trim();
	if (!rawBaseUrl) {
		throw new Error(MISSING_BASE_URL_MESSAGE);
	}
	const baseUrl = normalizePortkeyGatewayUrl(rawBaseUrl);
	const url = new URL(rawBaseUrl);
	const sanitizedCustomHeaders = withoutHeaders(
		credentials.customHeaders,
		PORTKEY_SECRET_HEADER_NAMES,
	);

	if (url.origin === PORTKEY_HOST) {
		if (!credentials.apiKey.trim()) {
			throw new Error(
				"Hosted Portkey requires a non-empty API key. Keyless connections are supported only " +
					"for self-hosted gateways or credential-injecting proxies.",
			);
		}
		// TODO(phase0-gate): auth-matrix probe — hosted auth is provisionally the
		// `x-portkey-api-key` header on every endpoint.
		const authHeaders = { "x-portkey-api-key": credentials.apiKey };
		return {
			mode: "hosted",
			baseUrl,
			chatHeaders: { ...sanitizedCustomHeaders, ...authHeaders },
			// Discovery bypasses the cached fetcher's additive-header merge, so the
			// shared SDK-managed filter (Authorization, x-api-key, …) is applied
			// here — the chat path gets the same filtering inside the delegates.
			discoveryHeaders: additiveHeaderRecord(
				authHeaders,
				withoutHeaders(sanitizedCustomHeaders, PORTKEY_ROUTING_HEADER_NAMES),
			),
		};
	}
	if (url.hostname === CANONICAL_PORTKEY_HOSTNAME) {
		throw new Error(
			`Invalid Portkey base URL "${rawBaseUrl}": the hosted Portkey host is only valid as ` +
				`exactly ${PORTKEY_HOSTED_BASE_URL} (HTTPS, default port). For a self-hosted gateway, ` +
				"use that gateway's own URL.",
		);
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
		baseUrl,
		upstreamKey: credentials.apiKey,
		chatHeaders: hasRoutingHeader
			? sanitizedCustomHeaders
			: { ...sanitizedCustomHeaders, "x-portkey-provider": "anthropic" },
	};
}

// ---------------------------------------------------------------------------
// Model discovery (hosted catalog)
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
		// The resolver's normalized base URL already ends in /v1 — append only
		// `/models` (never `/v1/models`, which would double the segment).
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
 * requires bare upstream ids. Model-id shape is validation only — it never
 * selects the mode (the base URL does).
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
				`Catalog "@provider-slug/model" ids require the hosted base URL ` +
				`${PORTKEY_HOSTED_BASE_URL}.`,
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
	const nativeKey = connection.mode === "hosted" ? HOSTED_DUMMY_NATIVE_KEY : connection.upstreamKey;
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
			// only when it normalizes to the same gateway; always delegate with
			// the resolver-owned URL.
			if (params.baseUrl !== undefined) {
				let overrideGateway: string | undefined;
				try {
					overrideGateway = normalizePortkeyGatewayUrl(params.baseUrl);
				} catch {
					overrideGateway = undefined;
				}
				if (overrideGateway !== connection.baseUrl) {
					throw new Error(
						`Portkey model "${params.model}" carries a base URL override "${params.baseUrl}" ` +
							`that does not match the connection's gateway "${connection.baseUrl}". ` +
							`Cross-gateway overrides are not supported — one Portkey connection is one ` +
							`gateway; configure a separate provider for the other URL.`,
					);
				}
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
