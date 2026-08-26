/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { CONNECT_BEDROCK_MODEL_IDS, CONNECT_BEDROCK_MODELS } from "ai-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chats = vi.hoisted(() => ({
	anthropic: vi.fn(async () => (async function* () {})()),
	bedrock: vi.fn(async () => (async function* () {})()),
}));

vi.mock("../../model-clients/AnthropicClient", () => ({
	AnthropicClient: vi.fn(function () {
		return { chat: chats.anthropic };
	}),
}));
vi.mock("../../model-clients/BedrockClient", () => ({
	BedrockClient: vi.fn(function () {
		return { chat: chats.bedrock };
	}),
}));

import { AnthropicClient } from "../../model-clients/AnthropicClient";
import { BedrockClient } from "../../model-clients/BedrockClient";
import type { CancellationToken, Logger, ProviderCredentials } from "../../types";
import {
	registerConnectProvider,
	shapeConnectIntegrations,
	type ConnectProviderCallbacks,
} from "../connect-provider";
import { ProviderRegistry } from "../ProviderRegistry";

const logger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

const CONNECT_URL = "https://connect.example.com";
const ANTHROPIC_GUID = "aaaa1111-1111-1111-1111-111111111111";
const AWS_GUID = "bbbb2222-2222-2222-2222-222222222222";
const ANTHROPIC_GATEWAY = `${CONNECT_URL}/__gateway__/anthropic/${ANTHROPIC_GUID}/v1`;
const BEDROCK_GATEWAY = `${CONNECT_URL}/__gateway__/bedrock/${AWS_GUID}`;
// Minted prefixes always embed the full guid; see mintIntegrationPrefix.
const ANTHROPIC_PREFIX = `posit-connect-anthropic-prod-${ANTHROPIC_GUID}`;
const AWS_PREFIX = `posit-connect-bedrock-team-${AWS_GUID}`;

const INTEGRATION_RECORDS = [
	{
		guid: ANTHROPIC_GUID,
		template: "anthropic",
		name: "Anthropic Prod",
		description: "Team key",
	},
	{
		guid: AWS_GUID,
		template: "aws",
		name: "Bedrock Team",
		description: null,
		auth_type: "Viewer",
		config: { sts_region: "us-west-2" },
	},
	// Service Account auth mints against content items, not the calling user.
	{
		guid: "cccc3333-3333-3333-3333-333333333333",
		template: "aws",
		name: "Service Bedrock",
		auth_type: "Service Account",
		config: {},
	},
	{
		guid: "dddd4444-4444-4444-4444-444444444444",
		template: "github",
		name: "GitHub",
	},
];

const ANTHROPIC_MODELS_BODY = {
	data: [{ id: "claude-sonnet-4-5-20250929", display_name: "Claude Sonnet 4.5" }],
};

const credentials = { type: "apikey", apiKey: "tok", baseUrl: CONNECT_URL } as const;

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

/** Route the two discovery endpoints; anything else is a test bug. */
function stubDiscoveryFetch(routes: Record<string, () => Response> = {}): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async (url: string) => {
		const route = {
			[`${CONNECT_URL}/__api__/v1/oauth/integrations`]: () => json(INTEGRATION_RECORDS),
			[`${ANTHROPIC_GATEWAY}/models`]: () => json(ANTHROPIC_MODELS_BODY),
			...routes,
		}[url];
		if (!route) throw new Error(`Unexpected fetch: ${url}`);
		return route();
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function mintSuccess(region = "us-west-2") {
	return vi.fn(async () => ({
		ok: true as const,
		credentials: {
			type: "aws-credentials" as const,
			region,
			accessKeyId: "AKIA",
			secretAccessKey: "SECRET",
			sessionToken: "SESSION",
		},
	}));
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("shapeConnectIntegrations", () => {
	it("keeps supported templates even from a verbatim allowlist, requires Viewer auth for aws, and drops guid-less records", () => {
		// "github" is in the allowlist but has no shaping rule, so it is still dropped.
		const shaped = shapeConnectIntegrations(
			[...INTEGRATION_RECORDS, { template: "anthropic", name: "No Guid" }],
			CONNECT_URL,
			["anthropic", "aws", "github"],
		);

		expect(shaped.map((integration) => integration.idPrefix)).toEqual([
			ANTHROPIC_PREFIX,
			AWS_PREFIX,
		]);
		expect(shaped[0]).toMatchObject({
			guid: ANTHROPIC_GUID,
			baseUrl: ANTHROPIC_GATEWAY,
			loginUrl: `${CONNECT_URL}/__oauth__/integrations/${ANTHROPIC_GUID}/login`,
		});
		expect(shaped[0].region).toBeUndefined();
		expect(shaped[1]).toMatchObject({
			guid: AWS_GUID,
			baseUrl: BEDROCK_GATEWAY,
			region: "us-west-2",
		});
	});

	it("mints prefixes from name, then description, then template, always suffixed with the guid", () => {
		const shaped = shapeConnectIntegrations(
			[
				{ guid: "guid-one", template: "anthropic", name: "Anthropic" },
				{ guid: "guid-two", template: "anthropic", name: "Anthropic" },
				{ guid: "guid-three", template: "anthropic", name: "", description: "Fallback Desc" },
				{ guid: "guid-four", template: "anthropic", name: "", description: "" },
			],
			CONNECT_URL,
			["anthropic"],
		);

		// Two integrations sharing a name still mint distinct prefixes — the
		// guid, not the slug, is what makes a prefix unique.
		expect(shaped.map((integration) => integration.idPrefix)).toEqual([
			"posit-connect-anthropic-guid-one",
			"posit-connect-anthropic-guid-two",
			"posit-connect-fallback-desc-guid-three",
			"posit-connect-anthropic-guid-four",
		]);
	});
});

describe("connect model fetcher", () => {
	function registryWithProvider(callbacks?: ConnectProviderCallbacks): ProviderRegistry {
		const registry = new ProviderRegistry(logger);
		registerConnectProvider(registry, logger, callbacks);
		return registry;
	}

	it("returns no models when the Connect server URL is missing", async () => {
		const fetchMock = stubDiscoveryFetch();
		const models = await registryWithProvider().getModelsForProvider("posit-connect", {
			type: "apikey",
			apiKey: "tok",
		});

		expect(models).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns no models for the wrong credential type", async () => {
		stubDiscoveryFetch();
		const models = await registryWithProvider().getModelsForProvider("posit-connect", {
			type: "oauth",
			accessToken: "tok",
		});

		expect(models).toEqual([]);
	});

	it("discovers integrations and namespaces each gateway's models", async () => {
		const fetchMock = stubDiscoveryFetch();
		// Trailing slash on the configured URL must not produce double-slash requests.
		const models = await registryWithProvider({
			getAwsCredentials: vi.fn(),
		}).getModelsForProvider("posit-connect", {
			...credentials,
			baseUrl: `${CONNECT_URL}/`,
		});

		expect(fetchMock).toHaveBeenCalledWith(
			`${CONNECT_URL}/__api__/v1/oauth/integrations`,
			expect.objectContaining({ headers: { Authorization: "Key tok" } }),
		);
		expect(fetchMock).toHaveBeenCalledWith(
			`${ANTHROPIC_GATEWAY}/models`,
			expect.objectContaining({
				headers: { "x-api-key": "tok", "anthropic-version": "2023-06-01" },
			}),
		);

		const anthropicModel = models.find(
			(model) => model.id === `${ANTHROPIC_PREFIX}/claude-sonnet-4-5-20250929`,
		);
		expect(anthropicModel).toMatchObject({
			name: "Claude Sonnet 4.5 (Anthropic Prod)",
			providerId: "posit-connect",
			vendor: "anthropic",
			protocol: "anthropic-messages",
			baseUrl: ANTHROPIC_GATEWAY,
			supportsWebSearch: true,
		});

		// Every declared Connect Bedrock model is a recognized Claude id today,
		// so it declares anthropic-messages — the route BedrockClient actually
		// takes for it — even though it is served through the bedrock gateway.
		const bedrockModels = models.filter((model) => model.id.startsWith(`${AWS_PREFIX}/`));
		expect(bedrockModels.map((model) => model.id)).toEqual(
			CONNECT_BEDROCK_MODEL_IDS.map((id) => `${AWS_PREFIX}/${id}`),
		);
		// Display names come from the declared table's human-readable name plus
		// the integration label, never the raw wire id.
		const [firstDeclared] = CONNECT_BEDROCK_MODELS;
		expect(models.find((model) => model.id === `${AWS_PREFIX}/${firstDeclared.id}`)?.name).toBe(
			`${firstDeclared.name} (Bedrock Team)`,
		);
		for (const model of bedrockModels) {
			expect(model).toMatchObject({
				providerId: "posit-connect",
				baseUrl: BEDROCK_GATEWAY,
				supportsWebSearch: false,
				protocol: "anthropic-messages",
			});
		}

		expect(models).toHaveLength(1 + CONNECT_BEDROCK_MODEL_IDS.length);
	});

	it("skips AWS-backed integrations and warns when no credential callback is provided", async () => {
		stubDiscoveryFetch();
		const models = await registryWithProvider().getModelsForProvider("posit-connect", credentials);

		expect(models.map((model) => model.id)).toEqual([
			`${ANTHROPIC_PREFIX}/claude-sonnet-4-5-20250929`,
		]);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("no AWS credential callback"));
	});

	it("isolates a failing integration's discovery from the others", async () => {
		stubDiscoveryFetch({
			[`${ANTHROPIC_GATEWAY}/models`]: () => json({ error: "boom" }, 500),
		});
		const models = await registryWithProvider({
			getAwsCredentials: vi.fn(),
		}).getModelsForProvider("posit-connect", credentials);

		expect(models.map((model) => model.id)).toEqual(
			CONNECT_BEDROCK_MODEL_IDS.map((id) => `${AWS_PREFIX}/${id}`),
		);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('discovery failed for integration "Anthropic Prod"'),
		);
	});

	it("intersects the host template allowlist with the supported set", async () => {
		stubDiscoveryFetch();
		const callbacks: ConnectProviderCallbacks = {
			getAwsCredentials: vi.fn(),
			templates: () => ["anthropic", "github"],
		};
		const models = await registryWithProvider(callbacks).getModelsForProvider(
			"posit-connect",
			credentials,
		);

		expect(models.every((model) => model.protocol === "anthropic-messages")).toBe(true);
		expect(models).toHaveLength(1);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("unsupported integration template(s): github"),
		);
	});
});

describe("connect chat routing", () => {
	function chatParams(model: string, protocol?: "anthropic-messages" | "bedrock-converse") {
		return {
			model,
			messages: [],
			cancellationToken,
			protocol,
			baseUrl: protocol === "bedrock-converse" ? BEDROCK_GATEWAY : ANTHROPIC_GATEWAY,
		};
	}

	function clientWithoutDiscovery(
		callbacks?: ConnectProviderCallbacks,
		creds: ProviderCredentials = credentials,
	) {
		const registry = new ProviderRegistry(logger);
		registerConnectProvider(registry, logger, callbacks);
		const client = registry.getClientForProvider("posit-connect", creds);
		expect(client).not.toBeNull();
		return client!;
	}

	async function clientAfterDiscovery(
		callbacks?: ConnectProviderCallbacks,
		creds: ProviderCredentials = credentials,
	) {
		stubDiscoveryFetch();
		const registry = new ProviderRegistry(logger);
		registerConnectProvider(registry, logger, callbacks);
		await registry.getModelsForProvider("posit-connect", creds);
		const client = registry.getClientForProvider("posit-connect", creds);
		expect(client).not.toBeNull();
		return client!;
	}

	it("routes anthropic-messages to an AnthropicClient spending the token at the gateway", async () => {
		const client = await clientAfterDiscovery();

		await client.chat(
			chatParams(`${ANTHROPIC_PREFIX}/claude-sonnet-4-5-20250929`, "anthropic-messages"),
		);

		expect(AnthropicClient).toHaveBeenCalledWith(
			{ apiKey: "tok" },
			ANTHROPIC_GATEWAY,
			undefined,
			logger,
		);
		expect(chats.anthropic).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "claude-sonnet-4-5-20250929",
				baseUrl: ANTHROPIC_GATEWAY,
			}),
		);
	});

	it("routes bedrock-converse through per-request STS credentials without forcing a protocol", async () => {
		const getAwsCredentials = mintSuccess();
		const client = await clientAfterDiscovery({ getAwsCredentials });
		const modelId = CONNECT_BEDROCK_MODEL_IDS[0];

		await client.chat(chatParams(`${AWS_PREFIX}/${modelId}`, "bedrock-converse"));

		expect(getAwsCredentials).toHaveBeenCalledWith(
			expect.objectContaining({ guid: AWS_GUID, region: "us-west-2" }),
			expect.any(AbortSignal),
		);
		expect(BedrockClient).toHaveBeenCalledWith(
			expect.objectContaining({
				region: "us-west-2",
				accessKeyId: "AKIA",
				secretAccessKey: "SECRET",
				sessionToken: "SESSION",
				// Connect's gateway redirect is a deliberate, trusted override, so
				// it must reach BedrockClient even when FIPS endpoints are enforced.
				allowBaseUrlUnderFips: true,
			}),
			logger,
		);
		// The model-id heuristic must keep us.anthropic.* ids on the native
		// Anthropic route, so no explicit protocol may be forwarded.
		expect(chats.bedrock).toHaveBeenCalledTimes(1);
		const delegated = chats.bedrock.mock.calls[0][0] as {
			model: string;
			protocol?: string;
			baseUrl?: string;
		};
		expect(delegated.model).toBe(modelId);
		expect(delegated.baseUrl).toBe(BEDROCK_GATEWAY);
		expect(delegated.protocol).toBeUndefined();
	});

	it("routes stamped models statelessly when the integration cache is empty", async () => {
		const getAwsCredentials = mintSuccess();
		const client = clientWithoutDiscovery({ getAwsCredentials });
		const modelId = CONNECT_BEDROCK_MODEL_IDS[0];

		await client.chat(chatParams(`${AWS_PREFIX}/${modelId}`, "bedrock-converse"));

		// No discovery ran, so the integration is synthesized from the stamp.
		expect(getAwsCredentials).toHaveBeenCalledWith(
			expect.objectContaining({ guid: AWS_GUID, template: "aws" }),
			expect.any(AbortSignal),
		);
		expect(BedrockClient).toHaveBeenCalledWith(
			expect.objectContaining({ region: "us-west-2" }),
			logger,
		);
		const delegated = chats.bedrock.mock.calls[0][0] as { model: string; baseUrl?: string };
		expect(delegated.model).toBe(modelId);
		expect(delegated.baseUrl).toBe(BEDROCK_GATEWAY);

		await client.chat(
			chatParams(`${ANTHROPIC_PREFIX}/claude-sonnet-4-5-20250929`, "anthropic-messages"),
		);
		expect(chats.anthropic).toHaveBeenCalledWith(
			expect.objectContaining({ baseUrl: ANTHROPIC_GATEWAY }),
		);
	});

	it("rejects a stamped model discovered against a different Connect server", async () => {
		const client = clientWithoutDiscovery();

		await expect(
			client.chat({
				model: `${ANTHROPIC_PREFIX}/claude-sonnet-4-5-20250929`,
				messages: [],
				cancellationToken,
				baseUrl: `https://other.example.com/__gateway__/anthropic/${ANTHROPIC_GUID}/v1`,
			}),
		).rejects.toThrow(/other\.example\.com.*Refresh the model list/s);
		expect(chats.anthropic).not.toHaveBeenCalled();
	});

	it("rejects a baseUrl that is not a Connect gateway route", async () => {
		const client = clientWithoutDiscovery();

		await expect(
			client.chat({
				model: `${ANTHROPIC_PREFIX}/claude-sonnet-4-5-20250929`,
				messages: [],
				cancellationToken,
				baseUrl: `${CONNECT_URL}/some/other/api`,
			}),
		).rejects.toThrow(/not a Connect gateway URL/);
	});

	it("resolves an unstamped override model through the discovery cache", async () => {
		const client = await clientAfterDiscovery();

		await client.chat({
			model: `${ANTHROPIC_PREFIX}/claude-3-haiku-20240307`,
			messages: [],
			cancellationToken,
		});

		expect(chats.anthropic).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "claude-3-haiku-20240307",
				baseUrl: ANTHROPIC_GATEWAY,
			}),
		);
	});

	it("resolves an unstamped model through the cache when ai-config falls back to the bare Connect root", async () => {
		// ai-config's resolver stamps a model with the provider's own baseUrl
		// when the model carries none of its own — the bare Connect server root,
		// not a real gateway URL. That fallback must be treated like "no
		// baseUrl" and fall through to the cache, not rejected as an unknown
		// gateway route.
		const client = await clientAfterDiscovery();

		await client.chat({
			model: `${ANTHROPIC_PREFIX}/claude-3-haiku-20240307`,
			messages: [],
			cancellationToken,
			baseUrl: CONNECT_URL,
		});

		expect(chats.anthropic).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "claude-3-haiku-20240307",
				baseUrl: ANTHROPIC_GATEWAY,
			}),
		);
	});

	it("asks for a model-list refresh when an unstamped model's prefix is unknown", async () => {
		const client = await clientAfterDiscovery();

		await expect(
			client.chat({
				model: "posit-connect-nonexistent/claude-sonnet-4-5-20250929",
				messages: [],
				cancellationToken,
			}),
		).rejects.toThrow(/Refresh the model list/);
	});

	it("never resolves an unstamped model against a cache populated by different credentials", async () => {
		// Discovery under one session's token must not leak its integrations to
		// a second session that never discovered against this provider — even
		// against the same Connect server.
		stubDiscoveryFetch();
		const registry = new ProviderRegistry(logger);
		registerConnectProvider(registry, logger);
		await registry.getModelsForProvider("posit-connect", credentials);

		const otherSession = { ...credentials, apiKey: "tok-other-user" };
		const client = registry.getClientForProvider("posit-connect", otherSession)!;

		await expect(
			client.chat({
				model: `${ANTHROPIC_PREFIX}/claude-3-haiku-20240307`,
				messages: [],
				cancellationToken,
			}),
		).rejects.toThrow(/Refresh the model list/);
		expect(chats.anthropic).not.toHaveBeenCalled();
	});

	it("keeps unstamped routing available for interleaved credential sessions", async () => {
		stubDiscoveryFetch();
		const registry = new ProviderRegistry(logger);
		registerConnectProvider(registry, logger);
		const firstSession = credentials;
		const secondSession = { ...credentials, apiKey: "tok-other-user" };

		await registry.getModelsForProvider("posit-connect", firstSession);
		await registry.getModelsForProvider("posit-connect", secondSession);
		// This is a model-cache hit for the first session. Routing state must
		// remain available without forcing another network discovery.
		await registry.getModelsForProvider("posit-connect", firstSession);

		const firstClient = registry.getClientForProvider("posit-connect", firstSession)!;
		await firstClient.chat({
			model: `${ANTHROPIC_PREFIX}/claude-3-haiku-20240307`,
			messages: [],
			cancellationToken,
		});

		expect(chats.anthropic).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "claude-3-haiku-20240307",
				baseUrl: ANTHROPIC_GATEWAY,
			}),
		);
	});

	it("drops integrations deleted on the server at the next discovery", async () => {
		stubDiscoveryFetch();
		const registry = new ProviderRegistry(logger);
		registerConnectProvider(registry, logger);
		await registry.getModelsForProvider("posit-connect", credentials);
		const client = registry.getClientForProvider("posit-connect", credentials)!;

		await client.chat({
			model: `${ANTHROPIC_PREFIX}/claude-3-haiku-20240307`,
			messages: [],
			cancellationToken,
		});
		expect(chats.anthropic).toHaveBeenCalledTimes(1);

		stubDiscoveryFetch({
			[`${CONNECT_URL}/__api__/v1/oauth/integrations`]: () => json([]),
		});
		registry.clearModelCache("posit-connect");
		await registry.getModelsForProvider("posit-connect", credentials);

		await expect(
			client.chat({
				model: `${ANTHROPIC_PREFIX}/claude-3-haiku-20240307`,
				messages: [],
				cancellationToken,
			}),
		).rejects.toThrow(/Refresh the model list/);
	});

	it("forwards an anthropic-messages override on an AWS-backed integration to Bedrock", async () => {
		const getAwsCredentials = mintSuccess();
		const client = await clientAfterDiscovery({ getAwsCredentials });
		const modelId = CONNECT_BEDROCK_MODEL_IDS[0];

		// The template selects the transport: the gateway still requires SigV4,
		// so the override picks the wire format inside BedrockClient instead of
		// re-routing to the token-spending Anthropic path.
		await client.chat({
			model: `${AWS_PREFIX}/${modelId}`,
			messages: [],
			cancellationToken,
			protocol: "anthropic-messages",
			baseUrl: BEDROCK_GATEWAY,
		});

		expect(chats.anthropic).not.toHaveBeenCalled();
		expect(chats.bedrock).toHaveBeenCalledWith(
			expect.objectContaining({ protocol: "anthropic-messages", baseUrl: BEDROCK_GATEWAY }),
		);
	});

	it("surfaces the failure code and login URL when AWS credentials cannot be minted", async () => {
		const loginUrl = `${CONNECT_URL}/__oauth__/integrations/${AWS_GUID}/login`;
		const client = await clientAfterDiscovery({
			getAwsCredentials: vi.fn(async () => ({
				ok: false as const,
				code: "oauth_session_required",
				detail: "No active session.",
				loginUrl,
			})),
		});

		await expect(
			client.chat(chatParams(`${AWS_PREFIX}/${CONNECT_BEDROCK_MODEL_IDS[0]}`, "bedrock-converse")),
		).rejects.toThrow(new RegExp(`oauth_session_required.*${loginUrl}`));
		expect(chats.bedrock).not.toHaveBeenCalled();
	});

	it("throws rather than fall back to ambient AWS credentials when the mint is incomplete", async () => {
		const client = await clientAfterDiscovery({
			getAwsCredentials: vi.fn(async () => ({
				ok: true as const,
				credentials: { type: "aws-credentials" as const, region: "us-west-2" },
			})),
		});

		await expect(
			client.chat(chatParams(`${AWS_PREFIX}/${CONNECT_BEDROCK_MODEL_IDS[0]}`, "bedrock-converse")),
		).rejects.toThrow(/incomplete AWS credentials/);
		expect(chats.bedrock).not.toHaveBeenCalled();
	});

	it("signs with the integration's sts_region over the minted region and warns", async () => {
		const client = await clientAfterDiscovery({ getAwsCredentials: mintSuccess("us-east-1") });

		await client.chat(
			chatParams(`${AWS_PREFIX}/${CONNECT_BEDROCK_MODEL_IDS[0]}`, "bedrock-converse"),
		);

		expect(BedrockClient).toHaveBeenCalledWith(
			expect.objectContaining({ region: "us-west-2" }),
			logger,
		);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("sts_region"));
	});

	it("passes provider customHeaders through to BedrockClient", async () => {
		const customHeaders = { "x-proxy-token": "t" };
		const client = await clientAfterDiscovery(
			{ getAwsCredentials: mintSuccess() },
			{
				...credentials,
				customHeaders,
			},
		);

		await client.chat(
			chatParams(`${AWS_PREFIX}/${CONNECT_BEDROCK_MODEL_IDS[0]}`, "bedrock-converse"),
		);

		expect(BedrockClient).toHaveBeenCalledWith(expect.objectContaining({ customHeaders }), logger);
	});

	it("leaves ids whose first segment is not a posit-connect- prefix unsplit", async () => {
		const arn =
			"arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0";
		const client = await clientAfterDiscovery({ getAwsCredentials: mintSuccess() });

		await client.chat({
			model: arn,
			messages: [],
			cancellationToken,
			protocol: "bedrock-converse",
			baseUrl: BEDROCK_GATEWAY,
		});

		const delegated = chats.bedrock.mock.calls[0][0] as { model: string };
		expect(delegated.model).toBe(arn);
	});

	it("rejects protocols the Connect gateways cannot serve", async () => {
		const client = await clientAfterDiscovery({ getAwsCredentials: mintSuccess() });

		await expect(
			client.chat({
				model: `${ANTHROPIC_PREFIX}/claude-sonnet-4-5-20250929`,
				messages: [],
				cancellationToken,
				protocol: "openai-chat",
				baseUrl: ANTHROPIC_GATEWAY,
			}),
		).rejects.toThrow(/cannot route protocol "openai-chat"/);

		await expect(
			client.chat({
				model: `${AWS_PREFIX}/${CONNECT_BEDROCK_MODEL_IDS[0]}`,
				messages: [],
				cancellationToken,
				protocol: "openai-chat",
				baseUrl: BEDROCK_GATEWAY,
			}),
		).rejects.toThrow(/cannot route protocol "openai-chat"/);
	});
});
