/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

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

const { resolveBedrockTransport } = vi.hoisted(() => ({
	resolveBedrockTransport: vi.fn(),
}));
vi.mock("../bedrock-transport", () => ({ resolveBedrockTransport }));

const catalogSend = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-bedrock", async (importOriginal) => ({
	...(await importOriginal<typeof import("@aws-sdk/client-bedrock")>()),
	BedrockClient: vi.fn(function () {
		return { send: catalogSend };
	}),
}));

import { BedrockClient as CatalogSdkClient } from "@aws-sdk/client-bedrock";
import { BEDROCK_FALLBACK_CONTEXT_LENGTH } from "ai-config";

import { AnthropicClient } from "../../model-clients/AnthropicClient";
import { BedrockClient } from "../../model-clients/BedrockClient";
import type { CancellationToken, Logger, ProviderCredentials } from "../../types";
import { WORKBENCH_GATEWAY_METADATA_ENV } from "../connect-gateway-metadata";
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
const MANTLE_ROUTE = `${CONNECT_URL}/__gateway__/bedrock-mantle/${AWS_GUID}`;
const MANTLE_CHAT_GATEWAY = `${MANTLE_ROUTE}/v1`;
const MANTLE_RESPONSES_GATEWAY = `${MANTLE_ROUTE}/openai/v1`;
// Minted prefixes always embed the full guid; see mintIntegrationPrefix.
const ANTHROPIC_PREFIX = `posit-connect-anthropic-prod-${ANTHROPIC_GUID}`;
const AWS_PREFIX = `posit-connect-bedrock-team-${AWS_GUID}`;
const BEDROCK_MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

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
			// The integration's Mantle route lists no models unless a test says otherwise.
			[`${MANTLE_CHAT_GATEWAY}/models`]: () => json({ data: [] }),
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

/** A gateway whose catalog lists only Claude Sonnet 4.5. */
function stubSonnetCatalog() {
	const bare = "anthropic.claude-sonnet-4-5-20250929-v1:0";
	catalogSend.mockImplementation(async (command: { constructor: { name: string } }) =>
		command.constructor.name === "ListInferenceProfilesCommand"
			? {
					inferenceProfileSummaries: [
						{
							status: "ACTIVE",
							inferenceProfileId: BEDROCK_MODEL_ID,
							models: [{ modelArn: `arn:aws:bedrock:us-west-2::foundation-model/${bare}` }],
						},
					],
				}
			: {
					modelSummaries: [
						{ modelId: bare, modelName: "Claude Sonnet 4.5", responseStreamingSupported: true },
					],
				},
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	resolveBedrockTransport.mockResolvedValue({
		useFipsEndpoint: false,
		runtimeBaseUrl: "https://bedrock-runtime.us-west-2.amazonaws.com",
		mantleEnabled: true,
	});
	// Catalog listing denied unless a test says otherwise: the declared table.
	catalogSend.mockRejectedValue(
		Object.assign(new Error("denied"), { name: "AccessDeniedException" }),
	);
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

	describe("reportDiscovery", () => {
		const discoveryCredentials = { ...credentials, baseUrl: CONNECT_URL };
		function callbacksWithSpy() {
			const reportDiscovery = vi.fn();
			return { reportDiscovery, callbacks: { getAwsCredentials: mintSuccess(), reportDiscovery } };
		}

		it("reports no-integrations when Connect lists none", async () => {
			stubDiscoveryFetch({ [`${CONNECT_URL}/__api__/v1/oauth/integrations`]: () => json([]) });
			const { reportDiscovery, callbacks } = callbacksWithSpy();

			await expect(
				registryWithProvider(callbacks).getModelsForProvider("posit-connect", discoveryCredentials),
			).resolves.toEqual([]);
			expect(reportDiscovery).toHaveBeenCalledExactlyOnceWith({ state: "no-integrations" });
		});

		it("reports ready when integrations are listed", async () => {
			stubDiscoveryFetch();
			stubSonnetCatalog();
			const { reportDiscovery, callbacks } = callbacksWithSpy();

			await registryWithProvider(callbacks).getModelsForProvider(
				"posit-connect",
				discoveryCredentials,
			);
			expect(reportDiscovery).toHaveBeenCalledExactlyOnceWith({ state: "ready" });
		});

		it("reports unreachable when the listing is rejected", async () => {
			stubDiscoveryFetch({
				[`${CONNECT_URL}/__api__/v1/oauth/integrations`]: () =>
					new Response("nope", { status: 401, statusText: "Unauthorized" }),
			});
			const { reportDiscovery, callbacks } = callbacksWithSpy();

			await registryWithProvider(callbacks).getModelsForProvider(
				"posit-connect",
				discoveryCredentials,
			);
			expect(reportDiscovery).toHaveBeenCalledExactlyOnceWith({
				state: "unreachable",
				status: 401,
			});
		});

		it("reports unreachable without a status on a network failure", async () => {
			stubDiscoveryFetch({
				[`${CONNECT_URL}/__api__/v1/oauth/integrations`]: () => {
					throw new TypeError("fetch failed");
				},
			});
			const { reportDiscovery, callbacks } = callbacksWithSpy();

			await registryWithProvider(callbacks).getModelsForProvider(
				"posit-connect",
				discoveryCredentials,
			);
			expect(reportDiscovery).toHaveBeenCalledExactlyOnceWith({
				state: "unreachable",
				status: undefined,
			});
		});
	});

	it("discovers integrations and namespaces each gateway's models", async () => {
		const fetchMock = stubDiscoveryFetch();
		stubSonnetCatalog();
		// Trailing slash on the configured URL must not produce double-slash requests.
		const models = await registryWithProvider({
			getAwsCredentials: mintSuccess(),
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
		expect(bedrockModels.map((model) => model.id)).toEqual([`${AWS_PREFIX}/${BEDROCK_MODEL_ID}`]);
		// Display names come from the declared table's human-readable name plus
		// the integration label, never the raw wire id.
		expect(models.find((model) => model.id === `${AWS_PREFIX}/${BEDROCK_MODEL_ID}`)?.name).toBe(
			"Claude Sonnet 4.5 (Bedrock Team)",
		);
		for (const model of bedrockModels) {
			expect(model).toMatchObject({
				providerId: "posit-connect",
				baseUrl: BEDROCK_GATEWAY,
				supportsWebSearch: false,
				protocol: "anthropic-messages",
			});
		}

		expect(models).toHaveLength(2);
	});

	describe("Bedrock model discovery", () => {
		function stubCatalog() {
			catalogSend.mockImplementation(async (command: { constructor: { name: string } }) => {
				if (command.constructor.name === "ListInferenceProfilesCommand") {
					return {
						inferenceProfileSummaries: [
							{
								status: "ACTIVE",
								inferenceProfileId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
								models: [
									{
										modelArn:
											"arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0",
									},
								],
							},
							{
								status: "ACTIVE",
								inferenceProfileId: "us.meta.llama3-3-70b-instruct-v1:0",
								models: [
									{
										modelArn:
											"arn:aws:bedrock:us-west-2::foundation-model/meta.llama3-3-70b-instruct-v1:0",
									},
								],
							},
							{
								status: "ACTIVE",
								inferenceProfileId: "us.amazon.nova-lite-v1:0",
								models: [
									{
										modelArn: "arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-lite-v1:0",
									},
								],
							},
							{
								status: "ACTIVE",
								inferenceProfileId: "us.twelvelabs.pegasus-1-5-v1:0",
								models: [
									{
										modelArn:
											"arn:aws:bedrock:us-west-2::foundation-model/twelvelabs.pegasus-1-5-v1:0",
									},
								],
							},
							// Served through Bedrock Mantle, a separate gateway route.
							{
								status: "ACTIVE",
								inferenceProfileId: "us.openai.gpt-oss-120b-1:0",
								models: [
									{
										modelArn: "arn:aws:bedrock:us-west-2::foundation-model/openai.gpt-oss-120b-1:0",
									},
								],
							},
							{
								status: "LEGACY",
								inferenceProfileId: "us.anthropic.claude-3-haiku-20240307-v1:0",
								models: [
									{
										modelArn:
											"arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-3-haiku-20240307-v1:0",
									},
								],
							},
							// Active profile, but the model is retired: AWS rejects invokes.
							{
								status: "ACTIVE",
								inferenceProfileId: "us.anthropic.claude-3-sonnet-20240229-v1:0",
								models: [
									{
										modelArn:
											"arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0",
									},
								],
							},
							// Active profile whose foundation model is marked LEGACY: still listed.
							{
								status: "ACTIVE",
								inferenceProfileId: "us.anthropic.claude-3-opus-20240229-v1:0",
								models: [
									{
										modelArn:
											"arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-3-opus-20240229-v1:0",
									},
								],
							},
						],
					};
				}
				return {
					modelSummaries: [
						{
							modelId: "anthropic.claude-sonnet-4-5-20250929-v1:0",
							modelName: "Claude Sonnet 4.5",
							responseStreamingSupported: true,
						},
						{
							modelId: "amazon.nova-lite-v1:0",
							modelName: "Nova Lite",
							responseStreamingSupported: true,
						},
						{ modelId: "twelvelabs.pegasus-1-5-v1:0", modelName: "Pegasus v1.5" },
						{ modelId: "meta.llama3-3-70b-instruct-v1:0", modelName: "Llama 3.3 70B Instruct" },
						{ modelId: "openai.gpt-oss-120b-1:0", modelName: "gpt-oss-120b" },
						{
							modelId: "anthropic.claude-3-opus-20240229-v1:0",
							modelName: "Claude 3 Opus",
							modelLifecycle: { status: "LEGACY" },
							// No streaming: Converse tool use is withheld, as in the direct provider.
							responseStreamingSupported: false,
						},
					],
				};
			});
		}

		async function bedrockModelIds(callbacks: ConnectProviderCallbacks) {
			stubDiscoveryFetch();
			const models = await registryWithProvider(callbacks).getModelsForProvider(
				"posit-connect",
				credentials,
			);
			return models.filter((model) => model.id.startsWith(`${AWS_PREFIX}/`));
		}

		it("lists active text models through the gateway, skipping Mantle-only ones", async () => {
			stubCatalog();
			const mint = mintSuccess();
			const models = await bedrockModelIds({ getAwsCredentials: mint });
			expect(models.map((model) => model.id)).toEqual([
				`${AWS_PREFIX}/us.amazon.nova-lite-v1:0`,
				`${AWS_PREFIX}/us.anthropic.claude-3-opus-20240229-v1:0`,
				`${AWS_PREFIX}/us.anthropic.claude-sonnet-4-5-20250929-v1:0`,
				`${AWS_PREFIX}/us.meta.llama3-3-70b-instruct-v1:0`,
				`${AWS_PREFIX}/us.twelvelabs.pegasus-1-5-v1:0`,
			]);
			expect(models.map((model) => [model.vendor, model.protocol, model.supportsTools])).toEqual([
				["amazon", "bedrock-converse", true],
				["anthropic", "anthropic-messages", false],
				["anthropic", "anthropic-messages", true],
				["meta", "bedrock-converse", false],
				["twelvelabs", "bedrock-converse", false],
			]);
			expect(models[2].name).toBe("Claude Sonnet 4.5 (Bedrock Team)");
			expect(models[0].baseName).toBe("Nova Lite");
			// Image support follows the vendor, as in the direct provider.
			expect(models.map((model) => model.supportsImages)).toEqual([true, true, true, false, false]);
			// An id outside the Claude table gets the shared Bedrock fallback window.
			expect(models[3]).toMatchObject({
				maxContextLength: BEDROCK_FALLBACK_CONTEXT_LENGTH,
				maxInputTokens: BEDROCK_FALLBACK_CONTEXT_LENGTH - 4_096,
			});
			expect(vi.mocked(CatalogSdkClient).mock.calls[0][0]).toMatchObject({
				endpoint: BEDROCK_GATEWAY,
				region: "us-west-2",
			});
		});

		it("lists no models and warns when the foundation-model listing fails", async () => {
			stubCatalog();
			const base = catalogSend.getMockImplementation()!;
			catalogSend.mockImplementation(async (command: { constructor: { name: string } }) => {
				if (command.constructor.name === "ListFoundationModelsCommand") {
					throw new Error("denied");
				}
				return base(command);
			});
			const models = await bedrockModelIds({ getAwsCredentials: mintSuccess() });
			expect(models).toEqual([]);
			expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("denied"));
		});

		it("lists no models and names the missing permissions when listing is denied", async () => {
			const models = await bedrockModelIds({ getAwsCredentials: mintSuccess() });
			expect(models).toEqual([]);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("bedrock:ListInferenceProfiles and bedrock:ListFoundationModels"),
			);
		});

		it("lists no models and warns on other failures", async () => {
			catalogSend.mockRejectedValue(new Error("socket hang up"));
			const models = await bedrockModelIds({ getAwsCredentials: mintSuccess() });
			expect(models).toEqual([]);
			expect(logger.warn).toHaveBeenCalled();
		});

		it("lists no models when credentials cannot be minted", async () => {
			stubCatalog();
			const models = await bedrockModelIds({
				getAwsCredentials: vi.fn(async () => ({
					ok: false as const,
					code: "oauth_session_required",
				})),
			});
			expect(models).toEqual([]);
			expect(catalogSend).not.toHaveBeenCalled();
		});

		describe("Bedrock Mantle models", () => {
			const MANTLE_LISTING = {
				data: [
					{ id: "openai.gpt-oss-120b-1:0", status: "available" },
					{ id: "openai.gpt-5.6-sol" },
					// Not in the Mantle capability table, so it is skipped.
					{ id: "openai.gpt-oss-safeguard-20b" },
				],
			};

			async function discover(
				mantle: () => Response | Promise<Response>,
				callbacks: ConnectProviderCallbacks = { getAwsCredentials: mintSuccess() },
			) {
				const fetchMock = stubDiscoveryFetch({
					[`${MANTLE_CHAT_GATEWAY}/models`]: mantle as never,
				});
				const models = await registryWithProvider(callbacks).getModelsForProvider(
					"posit-connect",
					credentials,
				);
				return {
					fetchMock,
					models: models.filter((model) => model.id.startsWith(`${AWS_PREFIX}/`)),
				};
			}

			it("lists Mantle-only models once, from the Mantle listing, next to the Runtime models", async () => {
				stubCatalog();
				const { models } = await discover(() => json(MANTLE_LISTING));

				// The Runtime listing keeps skipping us.openai.*: Mantle is the only source.
				expect(models.map((model) => model.id)).toEqual([
					`${AWS_PREFIX}/us.amazon.nova-lite-v1:0`,
					`${AWS_PREFIX}/us.anthropic.claude-3-opus-20240229-v1:0`,
					`${AWS_PREFIX}/us.anthropic.claude-sonnet-4-5-20250929-v1:0`,
					`${AWS_PREFIX}/us.meta.llama3-3-70b-instruct-v1:0`,
					`${AWS_PREFIX}/us.twelvelabs.pegasus-1-5-v1:0`,
					`${AWS_PREFIX}/openai.gpt-oss-120b-1:0`,
					`${AWS_PREFIX}/openai.gpt-5.6-sol`,
				]);
				expect(models.filter((model) => model.id.includes("gpt-oss-120b"))).toHaveLength(1);

				const [chat, responses] = models.slice(5);
				expect(chat).toMatchObject({
					providerId: "posit-connect",
					vendor: "openai",
					protocol: "openai-chat",
					baseUrl: MANTLE_CHAT_GATEWAY,
					maxOutputTokens: 16_384,
					supportsWebSearch: false,
				});
				expect(chat.name).toMatch(/\(Bedrock Team\)$/);
				expect(chat.baseName).toBe(chat.name.replace(/ \(Bedrock Team\)$/, ""));
				expect(responses).toMatchObject({
					vendor: "openai",
					protocol: "openai-responses",
					baseUrl: MANTLE_RESPONSES_GATEWAY,
					// The Mantle table marks GPT-5.6 as web-search capable, but web search
					// through the gateway is not offered.
					supportsWebSearch: false,
				});
				expect(responses.baseUrl!.startsWith(`${MANTLE_ROUTE}/`)).toBe(true);
				expect(chat.baseUrl!.startsWith(`${MANTLE_ROUTE}/`)).toBe(true);
			});

			it("lists through the gateway's Mantle route, signed for bedrock-mantle in the integration's region", async () => {
				stubCatalog();
				// The minted region differs; Connect verifies the integration's sts_region.
				const { fetchMock } = await discover(() => json(MANTLE_LISTING), {
					getAwsCredentials: mintSuccess("us-east-1"),
				});

				const mantleCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("mantle"));
				expect(mantleCalls).toHaveLength(1);
				const [url, init] = mantleCalls[0] as [string, RequestInit];
				expect(url).toBe(`${CONNECT_URL}/__gateway__/bedrock-mantle/${AWS_GUID}/v1/models`);
				const authorization = new Headers(init.headers).get("authorization");
				expect(authorization).toContain("Credential=AKIA/");
				expect(authorization).toContain("/us-west-2/bedrock-mantle/aws4_request");
			});

			it("keeps the Runtime models and names the action once when the Mantle listing is denied", async () => {
				stubCatalog();
				const { models } = await discover(() =>
					json(
						{
							message:
								"AccessDeniedException: User is not authorized to perform: bedrock-mantle:ListModels",
						},
						403,
					),
				);

				expect(models.map((model) => model.protocol)).toEqual([
					"bedrock-converse",
					"anthropic-messages",
					"anthropic-messages",
					"bedrock-converse",
					"bedrock-converse",
				]);
				const warnings = vi
					.mocked(logger.warn)
					.mock.calls.filter(([message]) => String(message).includes("bedrock-mantle:ListModels"));
				expect(warnings).toHaveLength(1);
			});

			it("skips the Mantle listing when AWS FIPS endpoints are enforced", async () => {
				stubCatalog();
				resolveBedrockTransport.mockResolvedValue({
					useFipsEndpoint: true,
					runtimeBaseUrl: "https://bedrock-runtime-fips.us-west-2.amazonaws.com",
					mantleEnabled: false,
				});
				const { fetchMock, models } = await discover(() => json(MANTLE_LISTING));

				// Chat refuses Mantle under FIPS, so only the Runtime models are listed.
				expect(models.map((model) => model.protocol)).toEqual([
					"bedrock-converse",
					"anthropic-messages",
					"anthropic-messages",
					"bedrock-converse",
					"bedrock-converse",
				]);
				expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("mantle"))).toEqual([]);
				expect(resolveBedrockTransport).toHaveBeenCalledWith(
					expect.objectContaining({ region: "us-west-2" }),
				);
			});

			it("keeps the Mantle models when the Runtime listing is denied", async () => {
				// catalogSend rejects with AccessDeniedException by default.
				const { models } = await discover(() => json(MANTLE_LISTING));

				expect(models.map((model) => model.id)).toEqual([
					`${AWS_PREFIX}/openai.gpt-oss-120b-1:0`,
					`${AWS_PREFIX}/openai.gpt-5.6-sol`,
				]);
				expect(logger.warn).toHaveBeenCalledWith(
					expect.stringContaining("bedrock:ListInferenceProfiles and bedrock:ListFoundationModels"),
				);
			});

			it("aborts a Mantle listing that never answers when discovery is cancelled", async () => {
				// Only the deadline timer is faked; signing and hashing still settle.
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
				try {
					stubCatalog();
					let mantleSignal: AbortSignal | undefined;
					const fetchMock = vi.fn((url: string, init?: RequestInit) => {
						if (url === `${MANTLE_CHAT_GATEWAY}/models`) {
							mantleSignal = init?.signal ?? undefined;
							return new Promise<Response>((_resolve, reject) => {
								mantleSignal?.addEventListener("abort", () => reject(mantleSignal!.reason));
							});
						}
						if (url === `${CONNECT_URL}/__api__/v1/oauth/integrations`) {
							return Promise.resolve(json(INTEGRATION_RECORDS));
						}
						return Promise.resolve(json(ANTHROPIC_MODELS_BODY));
					});
					vi.stubGlobal("fetch", fetchMock);

					const discovery = registryWithProvider({
						getAwsCredentials: mintSuccess(),
					}).getModelsForProvider("posit-connect", credentials);
					for (let i = 0; i < 1000 && !mantleSignal; i++) {
						await new Promise((resolve) => setImmediate(resolve));
					}
					expect(mantleSignal).toBeDefined();
					expect(mantleSignal!.aborted).toBe(false);

					// The discovery deadline aborts the shared signal.
					await vi.advanceTimersByTimeAsync(15_000);
					await discovery.catch(() => undefined);

					expect(mantleSignal!.aborted).toBe(true);
					const mantleCalls = fetchMock.mock.calls.filter(([url]) => url.includes("mantle"));
					expect(mantleCalls).toHaveLength(1);
					// An abort is not reported as a per-listing failure.
					expect(logger.warn).not.toHaveBeenCalledWith(
						expect.stringContaining("[Bedrock Mantle] Model listing failed"),
					);
				} finally {
					vi.useRealTimers();
				}
			});
		});
	});

	it("does not forward configured gateway metadata during discovery", async () => {
		const fetchMock = stubDiscoveryFetch();
		const models = await registryWithProvider().getModelsForProvider("posit-connect", {
			...credentials,
			customHeaders: {
				"gATEWAY-mETADATA": "workbench-session-id=fake",
				"x-proxy-token": "proxy",
			},
		});

		expect(models).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledWith(
			`${CONNECT_URL}/__api__/v1/oauth/integrations`,
			expect.objectContaining({
				headers: { Authorization: "Key tok", "x-proxy-token": "proxy" },
			}),
		);
		expect(fetchMock).toHaveBeenCalledWith(
			`${ANTHROPIC_GATEWAY}/models`,
			expect.objectContaining({
				headers: {
					"x-api-key": "tok",
					"anthropic-version": "2023-06-01",
					"x-proxy-token": "proxy",
				},
			}),
		);
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
		stubSonnetCatalog();
		const models = await registryWithProvider({
			getAwsCredentials: mintSuccess(),
		}).getModelsForProvider("posit-connect", credentials);

		expect(models.map((model) => model.id)).toEqual([`${AWS_PREFIX}/${BEDROCK_MODEL_ID}`]);
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
		env?: NodeJS.ProcessEnv,
	) {
		const registry = new ProviderRegistry(logger);
		registerConnectProvider(registry, logger, callbacks, env);
		const client = registry.getClientForProvider("posit-connect", creds);
		expect(client).not.toBeNull();
		return client!;
	}

	async function clientAfterDiscovery(
		callbacks?: ConnectProviderCallbacks,
		creds: ProviderCredentials = credentials,
		env?: NodeJS.ProcessEnv,
	) {
		stubDiscoveryFetch();
		const registry = new ProviderRegistry(logger);
		registerConnectProvider(registry, logger, callbacks, env);
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

	describe("gateway metadata header", () => {
		const HEADER = "Gateway-Metadata";
		const gatewayValue = "workbench-session-id=s1";
		const clientWithMetadata = (callbacks?: ConnectProviderCallbacks, creds = credentials) =>
			clientAfterDiscovery(callbacks, creds, { [WORKBENCH_GATEWAY_METADATA_ENV]: gatewayValue });

		it("does not read attribution during discovery", async () => {
			const read = vi.fn(() => gatewayValue);
			const env = {
				get [WORKBENCH_GATEWAY_METADATA_ENV]() {
					return read();
				},
			};
			await clientAfterDiscovery(undefined, credentials, env);
			expect(read).not.toHaveBeenCalled();
		});

		it("sends the header on the Anthropic route", async () => {
			const client = await clientWithMetadata();
			await client.chat(
				chatParams(`${ANTHROPIC_PREFIX}/claude-sonnet-4-5-20250929`, "anthropic-messages"),
			);
			expect(AnthropicClient).toHaveBeenCalledWith(
				{ apiKey: "tok" },
				ANTHROPIC_GATEWAY,
				{ [HEADER]: "workbench-session-id=s1" },
				logger,
			);
		});

		it("keeps other customHeaders alongside the header", async () => {
			const client = await clientWithMetadata(undefined, {
				...credentials,
				customHeaders: { "x-proxy-token": "t" },
			});
			await client.chat(
				chatParams(`${ANTHROPIC_PREFIX}/claude-sonnet-4-5-20250929`, "anthropic-messages"),
			);
			expect(AnthropicClient).toHaveBeenCalledWith(
				{ apiKey: "tok" },
				ANTHROPIC_GATEWAY,
				{ "x-proxy-token": "t", [HEADER]: "workbench-session-id=s1" },
				logger,
			);
		});

		it("combines configured and Workbench metadata without rewriting either value", async () => {
			const client = await clientAfterDiscovery(
				undefined,
				{
					...credentials,
					customHeaders: { "gateway-metadata": "team=analytics%20group" },
				},
				{
					[WORKBENCH_GATEWAY_METADATA_ENV]:
						"workbench-session-id=s1,workbench-project-name=My%20Project",
				},
			);
			await client.chat(chatParams(`${ANTHROPIC_PREFIX}/claude-sonnet-4-5-20250929`));
			expect(vi.mocked(AnthropicClient).mock.calls.at(-1)![2]).toEqual({
				[HEADER]:
					"workbench-session-id=s1,workbench-project-name=My%20Project,team=analytics%20group",
			});
		});

		it("sends configured metadata when Workbench provides none", async () => {
			const client = await clientAfterDiscovery(undefined, {
				...credentials,
				customHeaders: { "gATEWAY-mETADATA": "team=analytics" },
			});
			await client.chat(chatParams(`${ANTHROPIC_PREFIX}/claude-sonnet-4-5-20250929`));
			expect(vi.mocked(AnthropicClient).mock.calls.at(-1)![2]).toEqual({
				[HEADER]: "team=analytics",
			});
		});

		it("does not let an oversized combined header erase Workbench metadata", async () => {
			const client = await clientAfterDiscovery(
				undefined,
				{
					...credentials,
					customHeaders: { [HEADER]: "team=" + "x".repeat(4070) },
				},
				{ [WORKBENCH_GATEWAY_METADATA_ENV]: gatewayValue },
			);
			await client.chat(chatParams(`${ANTHROPIC_PREFIX}/claude-sonnet-4-5-20250929`));
			expect(vi.mocked(AnthropicClient).mock.calls.at(-1)![2]).toEqual({ [HEADER]: gatewayValue });
		});

		it("does not let too many configured fields erase Workbench metadata", async () => {
			const client = await clientAfterDiscovery(
				undefined,
				{
					...credentials,
					customHeaders: { [HEADER]: Array.from({ length: 16 }, (_, i) => `k${i}=v`).join(",") },
				},
				{ [WORKBENCH_GATEWAY_METADATA_ENV]: gatewayValue },
			);
			await client.chat(chatParams(`${ANTHROPIC_PREFIX}/claude-sonnet-4-5-20250929`));
			expect(vi.mocked(AnthropicClient).mock.calls.at(-1)![2]).toEqual({ [HEADER]: gatewayValue });
		});

		it("ignores a transport-unsafe configured value without losing Workbench metadata", async () => {
			const client = await clientWithMetadata(undefined, {
				...credentials,
				customHeaders: { [HEADER]: "team=raw\nnewline" },
			});
			await client.chat(chatParams(`${ANTHROPIC_PREFIX}/claude-sonnet-4-5-20250929`));
			expect(vi.mocked(AnthropicClient).mock.calls.at(-1)![2]).toEqual({ [HEADER]: gatewayValue });
		});

		it("sends combined metadata on the Bedrock route", async () => {
			const client = await clientWithMetadata(
				{ getAwsCredentials: mintSuccess() },
				{ ...credentials, customHeaders: { [HEADER]: "team=analytics" } },
			);
			await client.chat(chatParams(`${AWS_PREFIX}/${BEDROCK_MODEL_ID}`, "bedrock-converse"));
			expect(vi.mocked(BedrockClient).mock.calls.at(-1)![0].customHeaders).toEqual({
				[HEADER]: "workbench-session-id=s1,team=analytics",
			});
		});

		it("sends the header on the Bedrock route", async () => {
			const client = await clientWithMetadata({ getAwsCredentials: mintSuccess() });
			await client.chat(chatParams(`${AWS_PREFIX}/${BEDROCK_MODEL_ID}`, "bedrock-converse"));
			expect(BedrockClient).toHaveBeenCalledWith(
				expect.objectContaining({
					customHeaders: expect.objectContaining({ [HEADER]: "workbench-session-id=s1" }),
				}),
				logger,
			);
		});

		it("combines case-insensitive configured metadata headers without Workbench", async () => {
			const client = await clientAfterDiscovery(undefined, {
				...credentials,
				customHeaders: {
					"Gateway-Metadata": "region=east",
					"gATEWAY-mETADATA": "team=analytics",
				},
			});
			await client.chat(
				chatParams(`${ANTHROPIC_PREFIX}/claude-sonnet-4-5-20250929`, "anthropic-messages"),
			);
			expect(vi.mocked(AnthropicClient).mock.calls.at(-1)![2]).toEqual({
				[HEADER]: "region=east,team=analytics",
			});
		});

		it("keeps unrelated customHeaders when runtime metadata is absent", async () => {
			const client = await clientAfterDiscovery(undefined, {
				...credentials,
				customHeaders: {
					"gateway-metadata": "team=fake",
					"x-proxy-token": "t",
				},
			});
			await client.chat(
				chatParams(`${ANTHROPIC_PREFIX}/claude-sonnet-4-5-20250929`, "anthropic-messages"),
			);
			expect(vi.mocked(AnthropicClient).mock.calls.at(-1)![2]).toEqual({
				"x-proxy-token": "t",
				[HEADER]: "team=fake",
			});
		});

		it("uses configured metadata when Workbench metadata is transport-unsafe", async () => {
			const client = await clientAfterDiscovery(
				undefined,
				{
					...credentials,
					customHeaders: { "GATEWAY-METADATA": "team=fake" },
				},
				{ [WORKBENCH_GATEWAY_METADATA_ENV]: "team=raw\nnewline" },
			);
			await client.chat(
				chatParams(`${ANTHROPIC_PREFIX}/claude-sonnet-4-5-20250929`, "anthropic-messages"),
			);
			expect(vi.mocked(AnthropicClient).mock.calls.at(-1)![2]).toEqual({ [HEADER]: "team=fake" });
		});

		it("forwards even malformed metadata syntax unchanged for Connect to parse", async () => {
			const client = await clientAfterDiscovery(undefined, credentials, {
				[WORKBENCH_GATEWAY_METADATA_ENV]: "team=%ZZ",
			});
			await client.chat(chatParams(`${ANTHROPIC_PREFIX}/claude-sonnet-4-5-20250929`));
			expect(vi.mocked(AnthropicClient).mock.calls.at(-1)![2]).toEqual({ [HEADER]: "team=%ZZ" });
		});

		it("uses safe configured metadata when Workbench metadata is unsafe", async () => {
			const client = await clientAfterDiscovery(
				undefined,
				{ ...credentials, customHeaders: { "Gateway-Metadata": "team=forged" } },
				{ [WORKBENCH_GATEWAY_METADATA_ENV]: "team=raw\rreturn" },
			);
			await client.chat(chatParams(`${ANTHROPIC_PREFIX}/claude-sonnet-4-5-20250929`));
			expect(vi.mocked(AnthropicClient).mock.calls.at(-1)![2]).toEqual({ [HEADER]: "team=forged" });
		});

		it("sends configured metadata on the Bedrock route without Workbench", async () => {
			const client = await clientAfterDiscovery(
				{ getAwsCredentials: mintSuccess() },
				{
					...credentials,
					customHeaders: { "GATEWAY-METADATA": "team=fake" },
				},
			);
			await client.chat(chatParams(`${AWS_PREFIX}/${BEDROCK_MODEL_ID}`, "bedrock-converse"));
			expect(vi.mocked(BedrockClient).mock.calls.at(-1)![0].customHeaders).toEqual({
				[HEADER]: "team=fake",
			});
		});

		it("passes customHeaders through unchanged without metadata", async () => {
			const client = await clientAfterDiscovery();
			await client.chat(
				chatParams(`${ANTHROPIC_PREFIX}/claude-sonnet-4-5-20250929`, "anthropic-messages"),
			);
			expect(vi.mocked(AnthropicClient).mock.calls.at(-1)![2]).toBeUndefined();
		});
	});

	it("routes bedrock-converse through per-request STS credentials without forcing a protocol", async () => {
		const getAwsCredentials = mintSuccess();
		const client = await clientAfterDiscovery({ getAwsCredentials });
		const modelId = BEDROCK_MODEL_ID;

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
		// The aws re-read must not reach the network; make it fail so the stamp is used.
		stubDiscoveryFetch({
			[`${CONNECT_URL}/__api__/v1/oauth/integrations`]: () => json({}, 500),
		});
		const getAwsCredentials = mintSuccess();
		const client = clientWithoutDiscovery({ getAwsCredentials });
		const modelId = BEDROCK_MODEL_ID;

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

	it("re-reads the region for a stamped aws model with an empty cache", async () => {
		const fetchMock = stubDiscoveryFetch({
			[`${CONNECT_URL}/__api__/v1/oauth/integrations`]: () =>
				json([
					{
						guid: AWS_GUID,
						template: "aws",
						name: "Bedrock Team",
						auth_type: "Viewer",
						config: { sts_region: "eu-west-1" },
					},
				]),
		});
		const getAwsCredentials = mintSuccess("eu-west-1");
		const client = clientWithoutDiscovery({ getAwsCredentials });

		await client.chat(chatParams(`${AWS_PREFIX}/${BEDROCK_MODEL_ID}`, "bedrock-converse"));

		expect(getAwsCredentials).toHaveBeenCalledWith(
			expect.objectContaining({ guid: AWS_GUID, region: "eu-west-1" }),
			expect.any(AbortSignal),
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(BedrockClient).toHaveBeenCalledWith(
			expect.objectContaining({ region: "eu-west-1" }),
			logger,
		);
	});

	it("falls back to the stamp when the region re-read fails", async () => {
		stubDiscoveryFetch({
			[`${CONNECT_URL}/__api__/v1/oauth/integrations`]: () => json({}, 500),
		});
		const getAwsCredentials = mintSuccess();
		const client = clientWithoutDiscovery({ getAwsCredentials });

		await client.chat(chatParams(`${AWS_PREFIX}/${BEDROCK_MODEL_ID}`, "bedrock-converse"));

		const integration = getAwsCredentials.mock.calls[0][0] as { region?: string };
		expect(integration.region).toBeUndefined();
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	/** Integrations re-read that never answers until its signal aborts. */
	function stubStalledIntegrations() {
		let signal: AbortSignal | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn((_url: string, init?: RequestInit) => {
				signal = init?.signal ?? undefined;
				return new Promise<Response>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal!.reason));
				});
			}),
		);
		return { signal: () => signal };
	}

	async function untilDefined(read: () => unknown) {
		for (let i = 0; i < 1000 && !read(); i++) {
			await new Promise((resolve) => setImmediate(resolve));
		}
		expect(read()).toBeDefined();
	}

	it("abandons a stalled region re-read when the chat is cancelled", async () => {
		const stalled = stubStalledIntegrations();
		const getAwsCredentials = mintSuccess();
		const client = clientWithoutDiscovery({ getAwsCredentials });
		const listeners: Array<() => void> = [];
		const token: CancellationToken = {
			isCancellationRequested: false,
			onCancellationRequested: (listener: () => void) => {
				listeners.push(listener);
				return { dispose() {} };
			},
		};

		const chat = client.chat({
			...chatParams(`${AWS_PREFIX}/${BEDROCK_MODEL_ID}`, "bedrock-converse"),
			cancellationToken: token,
		});
		await untilDefined(stalled.signal);
		(token as { isCancellationRequested: boolean }).isCancellationRequested = true;
		for (const listener of listeners) listener();

		await expect(chat).rejects.toBeDefined();
		expect(getAwsCredentials).not.toHaveBeenCalled();
	});

	it("falls back to the stamp when the region re-read times out", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const stalled = stubStalledIntegrations();
			const getAwsCredentials = mintSuccess();
			const client = clientWithoutDiscovery({ getAwsCredentials });

			const chat = client.chat(chatParams(`${AWS_PREFIX}/${BEDROCK_MODEL_ID}`, "bedrock-converse"));
			await untilDefined(stalled.signal);
			await vi.advanceTimersByTimeAsync(15_000);
			await chat;

			expect(stalled.signal()!.aborted).toBe(true);
			const integration = getAwsCredentials.mock.calls[0][0] as { region?: string };
			expect(integration.region).toBeUndefined();
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("Could not re-read integration"),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not re-read the integrations endpoint when the record is cached", async () => {
		const client = await clientAfterDiscovery({ getAwsCredentials: mintSuccess() });
		const fetchMock = vi.mocked(fetch);
		const callsAfterDiscovery = fetchMock.mock.calls.filter(([url]) =>
			String(url).endsWith("/__api__/v1/oauth/integrations"),
		).length;

		await client.chat(chatParams(`${AWS_PREFIX}/${BEDROCK_MODEL_ID}`, "bedrock-converse"));

		const total = fetchMock.mock.calls.filter(([url]) =>
			String(url).endsWith("/__api__/v1/oauth/integrations"),
		).length;
		expect(callsAfterDiscovery).toBe(1);
		expect(total).toBe(1);
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
		const modelId = BEDROCK_MODEL_ID;

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
			client.chat(chatParams(`${AWS_PREFIX}/${BEDROCK_MODEL_ID}`, "bedrock-converse")),
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
			client.chat(chatParams(`${AWS_PREFIX}/${BEDROCK_MODEL_ID}`, "bedrock-converse")),
		).rejects.toThrow(/incomplete AWS credentials/);
		expect(chats.bedrock).not.toHaveBeenCalled();
	});

	it("signs with the integration's sts_region over the minted region and warns", async () => {
		const client = await clientAfterDiscovery({ getAwsCredentials: mintSuccess("us-east-1") });

		await client.chat(chatParams(`${AWS_PREFIX}/${BEDROCK_MODEL_ID}`, "bedrock-converse"));

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

		await client.chat(chatParams(`${AWS_PREFIX}/${BEDROCK_MODEL_ID}`, "bedrock-converse"));

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
				model: `${AWS_PREFIX}/${BEDROCK_MODEL_ID}`,
				messages: [],
				cancellationToken,
				protocol: "openai-chat",
				baseUrl: BEDROCK_GATEWAY,
			}),
		).rejects.toThrow(/cannot route protocol "openai-chat"/);
	});

	describe("Bedrock Mantle models", () => {
		const RESPONSES_MODEL = "openai.gpt-5.6-sol";
		const CHAT_MODEL = "openai.gpt-oss-120b-1:0";

		function delegated() {
			return chats.bedrock.mock.calls.at(-1)![0] as {
				model: string;
				protocol?: string;
				baseUrl?: string;
				webSearchEnabled?: boolean;
				bedrockExternalWebAccess?: boolean;
			};
		}

		it("routes a stamped Mantle model statelessly through the Mantle route with minted keys", async () => {
			// No discovery ran; the region comes from the integrations re-read.
			stubDiscoveryFetch();
			const getAwsCredentials = mintSuccess("us-east-1");
			const client = clientWithoutDiscovery({ getAwsCredentials });

			await client.chat({
				model: `${AWS_PREFIX}/${RESPONSES_MODEL}`,
				messages: [],
				cancellationToken,
				protocol: "openai-responses",
				baseUrl: MANTLE_RESPONSES_GATEWAY,
			});

			// parseGatewayBaseUrl reads the Mantle route as the aws template and guid.
			expect(getAwsCredentials).toHaveBeenCalledWith(
				expect.objectContaining({ guid: AWS_GUID, template: "aws" }),
				expect.any(AbortSignal),
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
			expect(delegated()).toMatchObject({
				model: RESPONSES_MODEL,
				protocol: "openai-responses",
				baseUrl: MANTLE_RESPONSES_GATEWAY,
			});
		});

		it("routes Chat Completions models to the /v1 Mantle stamp", async () => {
			const client = await clientAfterDiscovery({ getAwsCredentials: mintSuccess() });

			await client.chat({
				model: `${AWS_PREFIX}/${CHAT_MODEL}`,
				messages: [],
				cancellationToken,
				protocol: "openai-chat",
				baseUrl: MANTLE_CHAT_GATEWAY,
			});

			expect(delegated()).toMatchObject({
				model: CHAT_MODEL,
				protocol: "openai-chat",
				baseUrl: MANTLE_CHAT_GATEWAY,
			});
		});

		it("reads the protocol from the stamp's version prefix when none is declared", async () => {
			const client = await clientAfterDiscovery({ getAwsCredentials: mintSuccess() });

			await client.chat({
				model: `${AWS_PREFIX}/${RESPONSES_MODEL}`,
				messages: [],
				cancellationToken,
				baseUrl: MANTLE_RESPONSES_GATEWAY,
			});
			expect(delegated().protocol).toBe("openai-responses");

			await client.chat({
				model: `${AWS_PREFIX}/${CHAT_MODEL}`,
				messages: [],
				cancellationToken,
				baseUrl: MANTLE_CHAT_GATEWAY,
			});
			expect(delegated().protocol).toBe("openai-chat");
		});

		it("gives an unstamped Mantle model the integration's Mantle route for its protocol", async () => {
			const client = await clientAfterDiscovery({ getAwsCredentials: mintSuccess() });

			await client.chat({
				model: `${AWS_PREFIX}/${RESPONSES_MODEL}`,
				messages: [],
				cancellationToken,
				protocol: "openai-responses",
			});

			expect(delegated().baseUrl).toBe(MANTLE_RESPONSES_GATEWAY);
		});

		it("rejects a non-OpenAI protocol on the Mantle route", async () => {
			const client = await clientAfterDiscovery({ getAwsCredentials: mintSuccess() });

			await expect(
				client.chat({
					model: `${AWS_PREFIX}/${CHAT_MODEL}`,
					messages: [],
					cancellationToken,
					protocol: "bedrock-converse",
					baseUrl: MANTLE_CHAT_GATEWAY,
				}),
			).rejects.toThrow(/Bedrock Mantle route supports openai-chat and openai-responses/);
			expect(chats.bedrock).not.toHaveBeenCalled();
		});

		it("forwards the web search request fields to BedrockClient unchanged", async () => {
			const client = await clientAfterDiscovery({ getAwsCredentials: mintSuccess() });

			await client.chat({
				model: `${AWS_PREFIX}/${RESPONSES_MODEL}`,
				messages: [],
				cancellationToken,
				protocol: "openai-responses",
				baseUrl: MANTLE_RESPONSES_GATEWAY,
				webSearchEnabled: true,
				bedrockExternalWebAccess: false,
			});

			expect(delegated()).toMatchObject({
				webSearchEnabled: true,
				bedrockExternalWebAccess: false,
			});
		});
	});
});
