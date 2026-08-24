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
	CONNECT_BEDROCK_MODEL_IDS,
	getAnthropicModelCapabilities,
	getConnectBedrockModelCapabilities,
} from "ai-config";

import { additiveHeaderRecord } from "../custom-headers";
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
	 */
	getAwsCredentials(integration: ConnectIntegration): Promise<ConnectAwsCredentialResult>;
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
 * Derive a human-readable, deterministic model-id prefix from the
 * integration's admin-facing name (e.g. `connect-anthropic-superuser`) so
 * model ids are stable across discoveries. Falls back to description, then
 * template, when the name is blank; a within-batch collision (or an empty
 * slug) falls back to the guid, which is unique by construction.
 */
function mintIntegrationPrefix(input: {
	name: string;
	description: string;
	template: string;
	guid: string;
	takenIds: ReadonlySet<string>;
}): string {
	const slug = slugify(input.name) || slugify(input.description) || slugify(input.template);
	const candidate = slug ? `connect-${slug}` : `connect-${input.guid}`;
	if (!input.takenIds.has(candidate)) return candidate;
	const suffixed = `connect-${slug}-${input.guid.slice(0, 8)}`;
	return input.takenIds.has(suffixed) ? `connect-${input.guid}` : suffixed;
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
 * integrations (e.g. a credential transport) mint identical slugs.
 */
export function shapeConnectIntegrations(
	body: readonly unknown[],
	connectUrl: string,
	templates: readonly string[],
): ConnectIntegration[] {
	const integrations: ConnectIntegration[] = [];
	const takenIds = new Set<string>();
	for (const entry of body) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		const guid = typeof record.guid === "string" ? record.guid : "";
		if (!guid) continue;
		const template = nullString(record.template);
		if (!templates.includes(template)) continue;
		if (template === "aws" && nullString(record.auth_type) !== VIEWER_AUTH_TYPE) continue;
		const name = nullString(record.name);
		const description = nullString(record.description);
		const idPrefix = mintIntegrationPrefix({ name, description, template, guid, takenIds });
		takenIds.add(idPrefix);
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
 * Integrations discovered by the model fetcher, kept for the client's
 * per-request routing (`connect-<slug>` → guid/region/gateway). Entries are
 * merged, never cleared, so an in-flight chat on a model from a previous
 * discovery still resolves.
 */
interface ConnectIntegrationCache {
	readonly byPrefix: Map<string, ConnectIntegration>;
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

async function fetchIntegrationRecords(
	connectUrl: string,
	credentials: ApiKeyCredentials,
	signal: AbortSignal,
): Promise<unknown[]> {
	const headers = additiveHeaderRecord(
		{ Authorization: `Key ${credentials.apiKey}` },
		credentials.customHeaders,
	);
	const response = await fetch(`${connectUrl}${INTEGRATIONS_PATH}`, { headers, signal });
	if (!response.ok) {
		throw new Error(`Connect integrations endpoint returned ${response.status}`);
	}
	const body: unknown = await response.json();
	if (!Array.isArray(body)) {
		throw new Error("Connect integrations response was not a JSON array");
	}
	return body;
}

/**
 * Display-name suffix tying a model to its integration — one flat list serves
 * every integration, and two integrations can offer the same model. The
 * unique idPrefix stands in when the admin left the name blank.
 */
function integrationLabel(integration: ConnectIntegration): string {
	return integration.name || integration.idPrefix;
}

/** The declared Bedrock models for one `aws`-template integration. */
function bedrockGatewayModels(
	providerId: ResolvedProviderId,
	integration: ConnectIntegration,
): ModelInfo[] {
	return CONNECT_BEDROCK_MODEL_IDS.map((modelId) => ({
		id: `${integration.idPrefix}/${modelId}`,
		name: `${modelId} (${integrationLabel(integration)})`,
		providerId,
		vendor: "anthropic",
		...getConnectBedrockModelCapabilities(modelId),
		protocol: "bedrock-converse" as const,
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
	return createCachedModelFetcher<ApiKeyCredentials>({
		providerId,
		// The token AND the Connect server URL must both be present; without a
		// baseUrl there is nothing to discover against (Snowflake pattern).
		hasCredentials: (credentials) => Boolean(credentials.apiKey && credentials.baseUrl),
		fetchFresh: async (credentials, signal) => {
			const connectUrl = credentials.baseUrl!.replace(/\/+$/, "");
			const templates = resolveTemplates(callbacks?.templates?.(), logger);
			const records = await fetchIntegrationRecords(connectUrl, credentials, signal);
			const integrations = shapeConnectIntegrations(records, connectUrl, templates);
			for (const integration of integrations) {
				cache.byPrefix.set(integration.idPrefix, integration);
			}

			const models: ModelInfo[] = [];
			for (const integration of integrations) {
				if (integration.template === "aws") {
					models.push(...bedrockGatewayModels(providerId, integration));
					continue;
				}
				// One misconfigured integration must not hide the others, so
				// per-integration discovery failures are isolated — but a deadline
				// abort fails the whole discovery (the fetcher has already fallen
				// back), so it must not be swallowed as a per-integration failure.
				try {
					models.push(
						...(await discoverAnthropicGatewayModels(providerId, integration, credentials, signal)),
					);
				} catch (error) {
					if (signal.aborted) throw error;
					const message = error instanceof Error ? error.message : String(error);
					logger.warn(
						`[connect] Model discovery failed for integration "${integrationLabel(integration)}": ${message}`,
					);
				}
			}
			return models;
		},
		fallbackModels: [],
		logger,
	});
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Split a namespaced `connect-<slug>/<modelId>` id on the FIRST `/` only —
 * the minted prefix never contains one, but Bedrock model ids (ARNs) may.
 */
function splitConnectModelId(model: string): { prefix?: string; wireModel: string } {
	const separator = model.indexOf("/");
	if (separator <= 0) return { wireModel: model };
	return { prefix: model.slice(0, separator), wireModel: model.slice(separator + 1) };
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
		const { prefix, wireModel } = splitConnectModelId(params.model);
		const integration = prefix ? this.cache.byPrefix.get(prefix) : undefined;
		// Models are stamped with protocol/baseUrl at discovery; the cache covers
		// user-configured overrides that carry neither.
		const protocol =
			normalizeProtocol(params.protocol) ??
			(integration && (integration.template === "aws" ? "bedrock-converse" : "anthropic-messages"));
		const baseUrl = params.baseUrl ?? integration?.baseUrl;
		if (!baseUrl) {
			throw new Error(
				`Connect provider has no gateway base URL for model "${params.model}". ` +
					`Refresh the model list and try again.`,
			);
		}

		if (protocol === "anthropic-messages") {
			const client = new AnthropicClient(
				{ apiKey: this.credentials.apiKey },
				baseUrl,
				this.credentials.customHeaders,
				this.logger,
			);
			return client.chat({ ...params, model: wireModel, baseUrl });
		}

		if (protocol === "bedrock-converse") {
			return this.bedrockChat(params, wireModel, baseUrl, integration);
		}

		throw new Error(
			`Connect provider cannot route protocol "${params.protocol}" for model "${params.model}"; ` +
				`supported protocols are anthropic-messages and bedrock-converse.`,
		);
	}

	private async bedrockChat(
		params: ModelClientChatParams,
		wireModel: string,
		baseUrl: string,
		integration: ConnectIntegration | undefined,
	): Promise<AsyncIterable<LMStreamPart>> {
		if (!integration) {
			throw new Error(
				`Unknown Posit Connect integration for model "${params.model}". ` +
					`Refresh the model list and try again.`,
			);
		}
		if (!this.callbacks) {
			throw new Error(
				"Connect provider has no AWS credential callback; Bedrock-backed integrations are unavailable.",
			);
		}
		const result = await this.callbacks.getAwsCredentials(integration);
		if (!result.ok) {
			const detail = result.detail ? ` ${result.detail}` : "";
			const login = result.loginUrl ? ` Sign in at ${result.loginUrl} and try again.` : "";
			throw new Error(
				`Posit Connect could not mint AWS credentials (${result.code}).${detail}${login}`,
			);
		}
		const aws = result.credentials;
		const client = new BedrockClient(
			{
				region: aws.region,
				profile: aws.profile,
				accessKeyId: aws.accessKeyId,
				secretAccessKey: aws.secretAccessKey,
				sessionToken: aws.sessionToken,
			},
			this.logger,
		);
		// No explicit protocol: BedrockClient's model-id heuristic keeps
		// `us.anthropic.*` ids on the native Anthropic (InvokeModel) route, which
		// the gateway also allows and which supports thinking.
		return client.chat({ ...params, model: wireModel, baseUrl, protocol: undefined });
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
	// resolve a model's `connect-<slug>` prefix back to its integration.
	const cache: ConnectIntegrationCache = { byPrefix: new Map() };
	registry.registerModelFetcher(
		"connect",
		createConnectModelFetcher("connect", logger, cache, callbacks),
	);
	registry.registerClientFactory("connect", createConnectClientFactory(logger, cache, callbacks));
}
