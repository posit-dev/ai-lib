/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Posit Connect provider.
 *
 * One built-in provider fronts every OAuth integration a Connect server
 * offers. The provider credential is the session's federated token (an
 * `apikey`), and `baseUrl` is the Connect server URL. Discovery spends the
 * token on `GET {baseUrl}/__api__/v1/oauth/integrations`, keeps the
 * integrations whose `template` is allowlisted, and namespaces each
 * integration's models as `connect-<slug>/<modelId>` so one flat model list
 * can route back to the right gateway.
 *
 * Chat routing is stateless for discovery-stamped models: the stamped gateway
 * URL embeds the Connect server, the template (which selects the transport),
 * and the integration guid, so routing never depends on discovery-time state
 * that a re-registration, restart, or re-discovery could invalidate. The
 * integration cache exists only to resolve user-configured models that carry
 * no stamp.
 *
 * Two templates are shaped today:
 * - `anthropic` — a pass-through reverse proxy on
 *   `{connect}/__gateway__/anthropic/{guid}/v1` that swaps the federated
 *   token for the integration's real key. It has no path validator, so
 *   `GET /v1/models` reaches api.anthropic.com and models are discovered
 *   live per integration.
 * - `aws` — a SigV4-verifying proxy on `{connect}/__gateway__/bedrock/{guid}`
 *   that serves Bedrock *Runtime* operations only, so models are declared
 *   from ai-config's Connect Bedrock table rather than discovered. Requests
 *   are signed with per-integration STS credentials minted by the host
 *   (see {@link ConnectProviderCallbacks.getAwsCredentials}).
 */

import type { ResolvedProviderId } from "ai-config";
import {
	CONNECT_BEDROCK_MODELS,
	getAnthropicModelCapabilities,
	getConnectBedrockModelCapabilities,
} from "ai-config";

import { additiveHeaderRecord } from "../custom-headers";
import { createAbortControllerFromToken } from "../model-clients/ai-sdk-helpers";
import { AnthropicClient } from "../model-clients/AnthropicClient";
import { BedrockClient } from "../model-clients/BedrockClient";
import type { ModelClient, ModelClientChatParams } from "../model-clients/ModelClient";
import type { ApiKeyCredentials, AwsCredentials, Logger, LMStreamPart, ModelInfo } from "../types";
import { normalizeProtocol } from "../types";
import { createCachedModelFetcher } from "./cached-model-fetcher";
import type { ClientFactory, ProviderRegistry } from "./ProviderRegistry";

const DEFAULT_TEMPLATES = ["anthropic", "aws"] as const;
/**
 * Templates this module knows how to shape into gateway-backed models. A
 * host-configured allowlist is intersected with this set rather than trusted
 * outright — a template outside it has no shaping rule at all.
 */
const SUPPORTED_TEMPLATES: ReadonlySet<string> = new Set(DEFAULT_TEMPLATES);
/**
 * Connect's AWS template mints credentials for the *calling user* only under
 * Viewer auth (`connect/src/connect/auth/oauth2/templates_store.go`); Service
 * Account auth mints against a content item, which a user session is not.
 * Shaping one would produce models that always fail.
 */
const VIEWER_AUTH_TYPE = "Viewer";
/** Connect's own default when an AWS integration names no region. */
const DEFAULT_STS_REGION = "us-east-1";
const INTEGRATIONS_PATH = "/__api__/v1/oauth/integrations";
const ANTHROPIC_VERSION_HEADER = "2023-06-01";
const CONNECT_CACHE_MAX_ENTRIES = 32;

/** One allowlisted integration, shaped from Connect's integrations endpoint. */
export interface ConnectIntegration {
	/**
	 * The model-id namespace for this integration (`connect-<slug>`); every
	 * model it serves is listed as `<idPrefix>/<modelId>`. See
	 * {@link mintIntegrationPrefix}.
	 */
	readonly idPrefix: string;
	readonly guid: string;
	readonly template: string;
	readonly name: string;
	readonly description: string;
	/** The integration's gateway route; see {@link gatewayBaseUrl}. */
	readonly baseUrl: string;
	/**
	 * AWS region for `aws` integrations, read from the integration's own
	 * `config.sts_region`. Connect verifies inbound SigV4 against this exact
	 * value, so it must come from the record, never from local config.
	 * `undefined` for non-AWS templates.
	 */
	readonly region?: string;
	/**
	 * `{connect}/__oauth__/integrations/{guid}/login` — Connect's interactive
	 * login for this integration.
	 */
	readonly loginUrl: string;
}

/** A successfully minted set of per-integration AWS credentials. */
export interface ConnectAwsCredentialSuccess {
	ok: true;
	credentials: AwsCredentials;
	expiresAt?: string;
}

/** A failure to mint AWS credentials, translated from the host's wire form. */
export interface ConnectAwsCredentialFailure {
	ok: false;
	/** Machine-readable failure code, e.g. `"oauth_session_required"`. */
	code: string;
	detail?: string;
	/** The integration's login URL when signing in would fix the failure. */
	loginUrl?: string;
}

export type ConnectAwsCredentialResult = ConnectAwsCredentialSuccess | ConnectAwsCredentialFailure;

/**
 * Platform-provided Connect hooks. Pre-built by the Node caller and threaded
 * in through registration; the bridge must NOT construct these.
 */
export interface ConnectProviderCallbacks {
	/**
	 * Mint per-integration AWS credentials for an `aws`-template integration
	 * (rserver's `/connect_aws_credentials`, keyed by the integration's guid).
	 * Called per request — the credentials are short-lived STS material.
	 * `signal` aborts when the chat is cancelled; honor it so a cancelled chat
	 * is not held behind a hung credential exchange.
	 */
	getAwsCredentials(
		integration: ConnectIntegration,
		signal?: AbortSignal,
	): Promise<ConnectAwsCredentialResult>;
	/**
	 * The admin-configured template allowlist. The bridge intersects it with
	 * its supported set; absent means the default (`anthropic`, `aws`).
	 */
	templates?(): readonly string[];
}

// ---------------------------------------------------------------------------
// Integration shaping (ported from @assistant/rstudio's connectSession.ts,
// re-scoped from provider ids to model-id prefixes)
// ---------------------------------------------------------------------------

function slugify(input: string): string {
	return input
		.toLowerCase()
		.replace(/[\s_]+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-{2,}/g, "-")
		.replace(/^-|-$/g, "");
}

/**
 * Derive a human-readable model-id prefix from the integration's admin-facing
 * name (e.g. `connect-anthropic-superuser-<guid>`), falling back to
 * description, then template, when the name is blank. The guid is always
 * embedded, so two integrations can never mint the same prefix regardless of
 * record order — chat routing keys on the stamped gateway URL regardless, but
 * this keeps the prefix itself collision-free too.
 */
function mintIntegrationPrefix(input: {
	name: string;
	description: string;
	template: string;
	guid: string;
}): string {
	const slug = slugify(input.name) || slugify(input.description) || slugify(input.template);
	return slug ? `connect-${slug}-${input.guid}` : `connect-${input.guid}`;
}

/**
 * The gateway route for an integration. Anthropic's route is versioned
 * (`/v1`) because the Anthropic client appends bare paths; Bedrock's is not —
 * the AWS SDK appends `/model/{id}/{action}` itself.
 */
function gatewayBaseUrl(connectUrl: string, template: string, guid: string): string {
	return template === "aws"
		? `${connectUrl}/__gateway__/bedrock/${guid}`
		: `${connectUrl}/__gateway__/anthropic/${guid}/v1`;
}

/** Connect's interactive login for one integration; same shape for every template. */
function integrationLoginUrl(connectUrl: string, guid: string): string {
	return `${connectUrl}/__oauth__/integrations/${guid}/login`;
}

/** `name`/`description`/`template` are NullString on the wire; tolerate `null` as `""`. */
function nullString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** `config` is a string map on the wire, with secrets already stripped by Connect. */
function configString(record: Record<string, unknown>, key: string): string | undefined {
	const config = record.config;
	if (typeof config !== "object" || config === null) return undefined;
	const value = (config as Record<string, unknown>)[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Shape the integrations endpoint's raw body into allowlisted
 * {@link ConnectIntegration}s. Exported so hosts that resolve prefixes back to
 * integrations (e.g. a credential transport) mint identical slugs; templates
 * outside {@link SUPPORTED_TEMPLATES} are dropped here regardless of the
 * allowlist, so a host may pass the admin allowlist verbatim and still shape
 * the exact records (and prefixes) the bridge shapes.
 */
export function shapeConnectIntegrations(
	body: readonly unknown[],
	connectUrl: string,
	templates: readonly string[],
): ConnectIntegration[] {
	const integrations: ConnectIntegration[] = [];
	for (const entry of body) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		const guid = typeof record.guid === "string" ? record.guid : "";
		if (!guid) continue;
		const template = nullString(record.template);
		if (!templates.includes(template) || !SUPPORTED_TEMPLATES.has(template)) continue;
		if (template === "aws" && nullString(record.auth_type) !== VIEWER_AUTH_TYPE) continue;
		const name = nullString(record.name);
		const description = nullString(record.description);
		const idPrefix = mintIntegrationPrefix({ name, description, template, guid });
		integrations.push({
			idPrefix,
			guid,
			template,
			name,
			description,
			baseUrl: gatewayBaseUrl(connectUrl, template, guid),
			loginUrl: integrationLoginUrl(connectUrl, guid),
			...(template === "aws"
				? { region: configString(record, "sts_region") ?? DEFAULT_STS_REGION }
				: {}),
		});
	}
	return integrations;
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

/**
 * Credential-scoped routing facts for unstamped configured models. Entries
 * use the same bound and FIFO policy as the model cache, and clear with it.
 */
class ConnectIntegrationCache {
	private readonly entries = new Map<string, ReadonlyMap<string, ConnectIntegration>>();
	private generation = 0;

	currentGeneration(): number {
		return this.generation;
	}

	replace(
		credentialKey: string,
		integrations: readonly ConnectIntegration[],
		startedInGeneration: number,
	): void {
		if (this.generation !== startedInGeneration) return;
		this.entries.delete(credentialKey);
		this.entries.set(
			credentialKey,
			new Map(integrations.map((integration) => [integration.idPrefix, integration])),
		);
		while (this.entries.size > CONNECT_CACHE_MAX_ENTRIES) {
			const oldestKey = this.entries.keys().next().value;
			if (oldestKey === undefined) break;
			this.entries.delete(oldestKey);
		}
	}

	get(credentialKey: string, prefix: string): ConnectIntegration | undefined {
		return this.entries.get(credentialKey)?.get(prefix);
	}

	findByGuid(credentialKey: string, guid: string): ConnectIntegration | undefined {
		for (const integration of this.entries.get(credentialKey)?.values() ?? []) {
			if (integration.guid === guid) return integration;
		}
		return undefined;
	}

	clear(): void {
		this.generation += 1;
		this.entries.clear();
	}
}

/** Opaque fingerprint identifying the server and token that populated an entry. */
async function connectCredentialKey(
	connectUrl: string,
	credentials: ApiKeyCredentials,
): Promise<string> {
	const input = new TextEncoder().encode(`${connectUrl} ${credentials.apiKey}`);
	const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", input));
	let fingerprint = "";
	for (const byte of digest) {
		fingerprint += byte.toString(16).padStart(2, "0");
	}
	return fingerprint;
}

function resolveTemplates(
	configured: readonly string[] | undefined,
	logger: Logger,
): readonly string[] {
	if (!configured) return DEFAULT_TEMPLATES;
	const unsupported = configured.filter((template) => !SUPPORTED_TEMPLATES.has(template));
	if (unsupported.length > 0) {
		logger.warn(
			`[connect] Ignoring unsupported integration template(s): ${unsupported.join(", ")}; ` +
				`only ${[...SUPPORTED_TEMPLATES].join(", ")} can be shaped into models today.`,
		);
	}
	return configured.filter((template) => SUPPORTED_TEMPLATES.has(template));
}

/**
 * Fetch the integrations visible to this API key and shape the allowlisted
 * ones. Throws on HTTP failure or a non-array body. This is the canonical
 * read of the integrations endpoint — discovery and host test probes both go
 * through it so the path, auth convention, and validation cannot drift.
 */
export async function fetchConnectIntegrations(
	connectUrl: string,
	credentials: ApiKeyCredentials,
	templates: readonly string[],
	signal?: AbortSignal,
): Promise<ConnectIntegration[]> {
	const baseUrl = connectUrl.replace(/\/+$/, "");
	const headers = additiveHeaderRecord(
		{ Authorization: `Key ${credentials.apiKey}` },
		credentials.customHeaders,
	);
	const response = await fetch(`${baseUrl}${INTEGRATIONS_PATH}`, { headers, signal });
	if (!response.ok) {
		throw new Error(
			`Connect integrations endpoint returned ${response.status}: ${response.statusText}`,
		);
	}
	const body: unknown = await response.json();
	if (!Array.isArray(body)) {
		throw new Error("Connect integrations response was not a JSON array");
	}
	return shapeConnectIntegrations(body, baseUrl, templates);
}

/**
 * Display-name suffix tying a model to its integration — one flat list serves
 * every integration, and two integrations can offer the same model. The
 * unique idPrefix stands in when the admin left the name blank.
 */
function integrationLabel(integration: ConnectIntegration): string {
	return integration.name || integration.idPrefix;
}

/**
 * The declared Bedrock models for one `aws`-template integration. Models
 * recognized by the Anthropic-on-Bedrock table declare `anthropic-messages`
 * — the route {@link BedrockClient}'s heuristic actually takes for them — so
 * host-side behavior keyed on the declared protocol (e.g. explicit
 * prompt-cache markers) matches the wire format in use; anything else falls
 * back to `bedrock-converse`.
 */
function bedrockGatewayModels(
	providerId: ResolvedProviderId,
	integration: ConnectIntegration,
): ModelInfo[] {
	return CONNECT_BEDROCK_MODELS.map((model) => ({
		id: `${integration.idPrefix}/${model.id}`,
		name: `${model.name} (${integrationLabel(integration)})`,
		providerId,
		vendor: "anthropic",
		...getConnectBedrockModelCapabilities(model.id),
		protocol:
			getAnthropicModelCapabilities(model.id) !== undefined
				? ("anthropic-messages" as const)
				: ("bedrock-converse" as const),
		baseUrl: integration.baseUrl,
	}));
}

/**
 * Live per-integration discovery through the Anthropic gateway, which proxies
 * `GET /models` to api.anthropic.com with the integration's real key.
 */
async function discoverAnthropicGatewayModels(
	providerId: ResolvedProviderId,
	integration: ConnectIntegration,
	credentials: ApiKeyCredentials,
	signal: AbortSignal,
): Promise<ModelInfo[]> {
	const headers = additiveHeaderRecord(
		{ "x-api-key": credentials.apiKey, "anthropic-version": ANTHROPIC_VERSION_HEADER },
		credentials.customHeaders,
	);
	const response = await fetch(`${integration.baseUrl}/models`, { headers, signal });
	if (!response.ok) {
		throw new Error(`Anthropic gateway returned ${response.status}`);
	}
	const body: unknown = await response.json();
	const data =
		typeof body === "object" && body !== null ? (body as Record<string, unknown>).data : undefined;
	if (!Array.isArray(data)) {
		throw new Error("Anthropic gateway model list had no data array");
	}

	const models: ModelInfo[] = [];
	for (const entry of data) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		if (typeof record.id !== "string" || record.id.length === 0) continue;
		const displayName = typeof record.display_name === "string" ? record.display_name : record.id;
		models.push({
			id: `${integration.idPrefix}/${record.id}`,
			name: `${displayName} (${integrationLabel(integration)})`,
			providerId,
			vendor: "anthropic",
			family: undefined,
			maxInputTokens: 200_000,
			maxOutputTokens: 16_000,
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
			maxContextLength: 200_000,
			...getAnthropicModelCapabilities(record.id),
			// The gateway forwards to api.anthropic.com, so provider-native web
			// search works exactly as it does against Anthropic directly.
			supportsWebSearch: true,
			protocol: "anthropic-messages" as const,
			baseUrl: integration.baseUrl,
		});
	}
	return models;
}

function createConnectModelFetcher(
	providerId: ResolvedProviderId,
	logger: Logger,
	cache: ConnectIntegrationCache,
	callbacks?: ConnectProviderCallbacks,
) {
	const fetcher = createCachedModelFetcher<ApiKeyCredentials>({
		providerId,
		// The token AND the Connect server URL must both be present; without a
		// baseUrl there is nothing to discover against (Snowflake pattern).
		hasCredentials: (credentials) => Boolean(credentials.apiKey && credentials.baseUrl),
		// Different sessions against the same (or different) Connect server must
		// never share a cached model list — the list reflects which
		// integrations THIS token can see.
		cacheKey: (credentials) =>
			connectCredentialKey(credentials.baseUrl!.replace(/\/+$/, ""), credentials),
		maxCacheEntries: CONNECT_CACHE_MAX_ENTRIES,
		fetchFresh: async (credentials, signal) => {
			const cacheGeneration = cache.currentGeneration();
			const connectUrl = credentials.baseUrl!.replace(/\/+$/, "");
			const credentialKey = await connectCredentialKey(connectUrl, credentials);
			const templates = resolveTemplates(callbacks?.templates?.(), logger);
			const integrations = await fetchConnectIntegrations(
				connectUrl,
				credentials,
				templates,
				signal,
			);

			if (!callbacks && integrations.some((integration) => integration.template === "aws")) {
				logger.warn(
					"[connect] Skipping AWS-backed integrations: no AWS credential callback was provided, " +
						"so their gateway requests could never be signed.",
				);
			}
			const modelLists = await Promise.all(
				integrations.map(async (integration): Promise<ModelInfo[]> => {
					if (integration.template === "aws") {
						return callbacks ? bedrockGatewayModels(providerId, integration) : [];
					}
					// One misconfigured integration must not hide the others, so
					// per-integration discovery failures are isolated — but a deadline
					// abort fails the whole discovery (the fetcher has already fallen
					// back), so it must not be swallowed as a per-integration failure.
					try {
						return await discoverAnthropicGatewayModels(
							providerId,
							integration,
							credentials,
							signal,
						);
					} catch (error) {
						if (signal.aborted) throw error;
						const message = error instanceof Error ? error.message : String(error);
						logger.warn(
							`[connect] Model discovery failed for integration "${integrationLabel(integration)}": ${message}`,
						);
						return [];
					}
				}),
			);
			const models = modelLists.flat();
			if (signal.aborted) {
				throw signal.reason ?? new Error("Connect model discovery was aborted");
			}
			cache.replace(credentialKey, integrations, cacheGeneration);
			return models;
		},
		fallbackModels: [],
		logger,
	});
	const clearModelCache = fetcher.clearCache;
	fetcher.clearCache = () => {
		cache.clear();
		clearModelCache?.();
	};
	return fetcher;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Split a namespaced `connect-<slug>/<modelId>` id on the FIRST `/` only —
 * the minted prefix never contains one, but Bedrock model ids (ARNs) may.
 * A first segment that is not a minted `connect-` prefix (e.g. a raw ARN's
 * `arn:aws:...`) leaves the whole id as the wire model.
 */
function splitConnectModelId(model: string): { prefix?: string; wireModel: string } {
	const separator = model.indexOf("/");
	if (separator <= 0 || !model.slice(0, separator).startsWith("connect-")) {
		return { wireModel: model };
	}
	return { prefix: model.slice(0, separator), wireModel: model.slice(separator + 1) };
}

/**
 * Recover the routing facts a discovery stamp encodes. The gateway URL shape
 * ({@link gatewayBaseUrl}) embeds the Connect server, the proxy kind (which
 * names the template), and the integration guid, which is what makes
 * stamped-model routing stateless. Returns `undefined` for URLs that are not
 * Connect gateway routes.
 */
function parseGatewayBaseUrl(
	baseUrl: string,
): { connectUrl: string; template: string; guid: string } | undefined {
	const match = /^(.+?)\/__gateway__\/(anthropic|bedrock)\/([^/]+)/.exec(baseUrl);
	if (!match) return undefined;
	return {
		connectUrl: match[1],
		template: match[2] === "bedrock" ? "aws" : "anthropic",
		guid: match[3],
	};
}

/**
 * Routes each request to the integration's gateway: `anthropic-messages`
 * spends the federated token as `x-api-key` (the gateway swaps it for the
 * real key), `bedrock-converse` signs with per-request STS credentials minted
 * through {@link ConnectProviderCallbacks.getAwsCredentials}.
 */
class ConnectClient implements ModelClient {
	constructor(
		private readonly credentials: ApiKeyCredentials,
		private readonly cache: ConnectIntegrationCache,
		private readonly logger: Logger,
		private readonly callbacks?: ConnectProviderCallbacks,
	) {}

	async chat(params: ModelClientChatParams): Promise<AsyncIterable<LMStreamPart>> {
		const connectUrl = this.credentials.baseUrl?.replace(/\/+$/, "");
		if (!connectUrl) {
			throw new Error("Connect provider credentials carry no Connect server URL.");
		}
		const { prefix, wireModel } = splitConnectModelId(params.model);

		// A discovery-stamped baseUrl is the source of truth: it names the
		// server, template, and guid, so routing never depends on cache state.
		// An unstamped model resolves to the bare Connect root as ai-config's
		// fallback (the provider's own configured baseUrl), which is not a real
		// stamp — treat it the same as no baseUrl at all and fall back to the
		// cache. Only user-configured models without a real stamp reach that
		// fallback.
		const hasStampedBaseUrl =
			Boolean(params.baseUrl) && params.baseUrl!.replace(/\/+$/, "") !== connectUrl;

		let integration: ConnectIntegration;
		if (hasStampedBaseUrl) {
			const parsed = parseGatewayBaseUrl(params.baseUrl!);
			if (!parsed) {
				throw new Error(
					`Connect provider model "${params.model}" has base URL "${params.baseUrl}", ` +
						`which is not a Connect gateway URL.`,
				);
			}
			if (parsed.connectUrl !== connectUrl) {
				throw new Error(
					`Connect provider model "${params.model}" was discovered against ${parsed.connectUrl}, ` +
						`but the provider now points at ${connectUrl}. Refresh the model list and try again.`,
				);
			}
			integration = await this.resolveIntegration(parsed, prefix);
		} else {
			const credentialKey = await connectCredentialKey(connectUrl, this.credentials);
			const cached = prefix ? this.cache.get(credentialKey, prefix) : undefined;
			if (!cached) {
				throw new Error(
					`Connect provider has no gateway base URL for model "${params.model}". ` +
						`Refresh the model list and try again.`,
				);
			}
			integration = cached;
		}

		const protocol = normalizeProtocol(params.protocol);
		// An unstamped model's baseUrl (when present at all) is ai-config's bare
		// Connect-root fallback, not a real gateway route — always route through
		// the resolved integration's baseUrl in that case.
		const baseUrl = hasStampedBaseUrl ? params.baseUrl! : integration.baseUrl;

		// The template selects the transport — a protocol override can pick the
		// wire format within it, but never re-routes off the integration's
		// gateway (an aws gateway always requires SigV4, whatever the protocol).
		if (integration.template === "aws") {
			if (protocol && protocol !== "bedrock-converse" && protocol !== "anthropic-messages") {
				throw new Error(
					`Connect provider cannot route protocol "${params.protocol}" for model "${params.model}"; ` +
						`an AWS-backed integration supports bedrock-converse and anthropic-messages.`,
				);
			}
			return this.bedrockChat(
				params,
				wireModel,
				baseUrl,
				integration,
				protocol === "anthropic-messages" ? "anthropic-messages" : undefined,
			);
		}

		if (protocol && protocol !== "anthropic-messages") {
			throw new Error(
				`Connect provider cannot route protocol "${params.protocol}" for model "${params.model}"; ` +
					`an Anthropic-backed integration supports only anthropic-messages.`,
			);
		}
		const client = new AnthropicClient(
			{ apiKey: this.credentials.apiKey },
			baseUrl,
			this.credentials.customHeaders,
			this.logger,
		);
		return client.chat({ ...params, model: wireModel, baseUrl });
	}

	/**
	 * Resolve the integration record for a stamped model: prefer the cached
	 * record (it carries the admin-facing name and `sts_region`) when it came
	 * from these same credentials, else synthesize one from the stamp so
	 * routing survives an empty, replaced, or foreign-credential cache.
	 */
	private async resolveIntegration(
		parsed: { connectUrl: string; template: string; guid: string },
		prefix: string | undefined,
	): Promise<ConnectIntegration> {
		const credentialKey = await connectCredentialKey(parsed.connectUrl, this.credentials);
		const cached = this.cache.findByGuid(credentialKey, parsed.guid);
		if (cached) return cached;
		return {
			idPrefix: prefix ?? `connect-${parsed.guid}`,
			guid: parsed.guid,
			template: parsed.template,
			name: "",
			description: "",
			baseUrl: gatewayBaseUrl(parsed.connectUrl, parsed.template, parsed.guid),
			loginUrl: integrationLoginUrl(parsed.connectUrl, parsed.guid),
		};
	}

	private async bedrockChat(
		params: ModelClientChatParams,
		wireModel: string,
		baseUrl: string,
		integration: ConnectIntegration,
		protocol: "anthropic-messages" | undefined,
	): Promise<AsyncIterable<LMStreamPart>> {
		if (!this.callbacks) {
			throw new Error(
				"Connect provider has no AWS credential callback; Bedrock-backed integrations are unavailable.",
			);
		}
		// The mint is a network exchange of its own; tie it to the chat's
		// cancellation so an abandoned request is not held behind it.
		const { abortController, cleanup } = createAbortControllerFromToken(params.cancellationToken);
		let result: ConnectAwsCredentialResult;
		try {
			result = await this.callbacks.getAwsCredentials(integration, abortController.signal);
		} finally {
			cleanup();
		}
		if (!result.ok) {
			const detail = result.detail ? ` ${result.detail}` : "";
			const login = result.loginUrl ? ` Sign in at ${result.loginUrl} and try again.` : "";
			throw new Error(
				`Posit Connect could not mint AWS credentials (${result.code}).${detail}${login}`,
			);
		}
		const aws = result.credentials;
		if (!aws.accessKeyId || !aws.secretAccessKey) {
			// An incomplete key set would send BedrockClient to the ambient AWS
			// credential chain — the wrong identity for a gateway that verifies
			// the minted one.
			throw new Error(
				`Posit Connect returned incomplete AWS credentials for integration ` +
					`"${integrationLabel(integration)}".`,
			);
		}
		// Connect verifies inbound SigV4 against the integration record's
		// sts_region, so prefer it; the minted material's region covers a
		// synthesized record that has none.
		const region = integration.region ?? aws.region;
		if (integration.region && aws.region && integration.region !== aws.region) {
			this.logger.warn(
				`[connect] Integration "${integrationLabel(integration)}" declares sts_region ` +
					`${integration.region} but the minted credentials name ${aws.region}; signing with ${region}.`,
			);
		}
		const client = new BedrockClient(
			{
				region,
				accessKeyId: aws.accessKeyId,
				secretAccessKey: aws.secretAccessKey,
				sessionToken: aws.sessionToken,
				customHeaders: this.credentials.customHeaders,
				// Routing through Connect's gateway is a deliberate, admin-configured
				// redirect (not an accidental override), so it overrides even a FIPS
				// runtime endpoint.
				allowBaseUrlUnderFips: true,
			},
			this.logger,
		);
		// Absent protocol: BedrockClient's model-id heuristic keeps
		// `us.anthropic.*` ids on the native Anthropic (InvokeModel) route, which
		// the gateway also allows and which supports thinking.
		return client.chat({ ...params, model: wireModel, baseUrl, protocol });
	}
}

function createConnectClientFactory(
	logger: Logger,
	cache: ConnectIntegrationCache,
	callbacks?: ConnectProviderCallbacks,
): ClientFactory {
	return (credentials) => {
		if (credentials.type !== "apikey") {
			throw new Error(`Connect provider requires API key credentials, got: ${credentials.type}`);
		}
		return new ConnectClient(credentials, cache, logger, callbacks);
	};
}

export function registerConnectProvider(
	registry: ProviderRegistry,
	logger: Logger,
	callbacks?: ConnectProviderCallbacks,
): void {
	// Shared between the fetcher (writer) and the client (reader) so chat can
	// resolve user-configured models that carry no discovery stamp; stamped
	// models route from their gateway URL alone.
	const cache = new ConnectIntegrationCache();
	registry.registerModelFetcher(
		"connect",
		createConnectModelFetcher("connect", logger, cache, callbacks),
	);
	registry.registerClientFactory("connect", createConnectClientFactory(logger, cache, callbacks));
}
