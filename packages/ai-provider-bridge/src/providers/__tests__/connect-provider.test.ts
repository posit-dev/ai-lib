/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { CONNECT_BEDROCK_MODEL_IDS } from "ai-config";
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
import type { CancellationToken, Logger } from "../../types";
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

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("shapeConnectIntegrations", () => {
	it("keeps allowlisted templates, requires Viewer auth for aws, and drops guid-less records", () => {
		const shaped = shapeConnectIntegrations(
			[...INTEGRATION_RECORDS, { template: "anthropic", name: "No Guid" }],
			CONNECT_URL,
			["anthropic", "aws"],
		);

		expect(shaped.map((integration) => integration.idPrefix)).toEqual([
			"connect-anthropic-prod",
			"connect-bedrock-team",
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

	it("mints prefixes from name, then description, then template, falling back to the guid on collision", () => {
		const shaped = shapeConnectIntegrations(
			[
				{ guid: "guid-one-12345678", template: "anthropic", name: "Anthropic" },
				{ guid: "guid-two-12345678", template: "anthropic", name: "Anthropic" },
				{ guid: "guid-three-1234", template: "anthropic", name: "", description: "Fallback Desc" },
				{ guid: "guid4", template: "anthropic", name: "", description: "" },
			],
			CONNECT_URL,
			["anthropic"],
		);

		expect(shaped.map((integration) => integration.idPrefix)).toEqual([
			"connect-anthropic",
			"connect-anthropic-guid-two",
			"connect-fallback-desc",
			"connect-anthropic-guid4",
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
		const models = await registryWithProvider().getModelsForProvider("connect", {
			type: "apikey",
			apiKey: "tok",
		});

		expect(models).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns no models for the wrong credential type", async () => {
		stubDiscoveryFetch();
		const models = await registryWithProvider().getModelsForProvider("connect", {
			type: "oauth",
			accessToken: "tok",
		});

		expect(models).toEqual([]);
	});

	it("discovers integrations and namespaces each gateway's models", async () => {
		const fetchMock = stubDiscoveryFetch();
		// Trailing slash on the configured URL must not produce double-slash requests.
		const models = await registryWithProvider().getModelsForProvider("connect", {
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
			(model) => model.id === "connect-anthropic-prod/claude-sonnet-4-5-20250929",
		);
		expect(anthropicModel).toMatchObject({
			name: "Claude Sonnet 4.5 (Anthropic Prod)",
			providerId: "connect",
			vendor: "anthropic",
			protocol: "anthropic-messages",
			baseUrl: ANTHROPIC_GATEWAY,
			supportsWebSearch: true,
		});

		const bedrockModels = models.filter((model) => model.protocol === "bedrock-converse");
		expect(bedrockModels.map((model) => model.id)).toEqual(
			CONNECT_BEDROCK_MODEL_IDS.map((id) => `connect-bedrock-team/${id}`),
		);
		for (const model of bedrockModels) {
			expect(model).toMatchObject({
				providerId: "connect",
				baseUrl: BEDROCK_GATEWAY,
				supportsWebSearch: false,
			});
		}

		expect(models).toHaveLength(1 + CONNECT_BEDROCK_MODEL_IDS.length);
	});

	it("isolates a failing integration's discovery from the others", async () => {
		stubDiscoveryFetch({
			[`${ANTHROPIC_GATEWAY}/models`]: () => json({ error: "boom" }, 500),
		});
		const models = await registryWithProvider().getModelsForProvider("connect", credentials);

		expect(models.map((model) => model.id)).toEqual(
			CONNECT_BEDROCK_MODEL_IDS.map((id) => `connect-bedrock-team/${id}`),
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
			"connect",
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

	async function clientAfterDiscovery(callbacks?: ConnectProviderCallbacks) {
		stubDiscoveryFetch();
		const registry = new ProviderRegistry(logger);
		registerConnectProvider(registry, logger, callbacks);
		await registry.getModelsForProvider("connect", credentials);
		const client = registry.getClientForProvider("connect", credentials);
		expect(client).not.toBeNull();
		return client!;
	}

	it("routes anthropic-messages to an AnthropicClient spending the token at the gateway", async () => {
		const client = await clientAfterDiscovery();

		await client.chat(
			chatParams("connect-anthropic-prod/claude-sonnet-4-5-20250929", "anthropic-messages"),
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
		const getAwsCredentials = vi.fn(async () => ({
			ok: true as const,
			credentials: {
				type: "aws-credentials" as const,
				region: "us-west-2",
				accessKeyId: "AKIA",
				secretAccessKey: "SECRET",
				sessionToken: "SESSION",
			},
		}));
		const client = await clientAfterDiscovery({ getAwsCredentials });
		const modelId = CONNECT_BEDROCK_MODEL_IDS[0];

		await client.chat(chatParams(`connect-bedrock-team/${modelId}`, "bedrock-converse"));

		expect(getAwsCredentials).toHaveBeenCalledWith(
			expect.objectContaining({ guid: AWS_GUID, region: "us-west-2" }),
		);
		expect(BedrockClient).toHaveBeenCalledWith(
			expect.objectContaining({
				region: "us-west-2",
				accessKeyId: "AKIA",
				secretAccessKey: "SECRET",
				sessionToken: "SESSION",
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
			client.chat(
				chatParams(`connect-bedrock-team/${CONNECT_BEDROCK_MODEL_IDS[0]}`, "bedrock-converse"),
			),
		).rejects.toThrow(new RegExp(`oauth_session_required.*${loginUrl}`));
		expect(chats.bedrock).not.toHaveBeenCalled();
	});

	it("rejects protocols the Connect gateways cannot serve", async () => {
		const client = await clientAfterDiscovery();

		await expect(
			client.chat({
				model: "connect-anthropic-prod/claude-sonnet-4-5-20250929",
				messages: [],
				cancellationToken,
				protocol: "openai-chat",
				baseUrl: ANTHROPIC_GATEWAY,
			}),
		).rejects.toThrow(/cannot route protocol "openai-chat"/);
	});
});
