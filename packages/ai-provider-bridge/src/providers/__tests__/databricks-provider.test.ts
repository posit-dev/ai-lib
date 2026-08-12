/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Databricks provider: discovery stamping, the pinned surface decision, and the
 * route seam / client multiplexer.
 *
 * Classification rules themselves live in ai-config
 * (`inferDatabricksModelProfile`) and are covered by its own mechanism tests;
 * what is tested here is this module's *wiring* of them — which endpoints get
 * listed, which protocol each stamp routes to, and the exact request each
 * surface × protocol pair produces.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelClient } from "../../model-clients/ModelClient";
import type { CancellationToken, Logger, Protocol } from "../../types";
import {
	parseFoundationModelsResponse,
	parseServingEndpointsResponse,
	registerDatabricksProvider,
} from "../databricks-provider";
import { ProviderRegistry } from "../ProviderRegistry";

const mockLogger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

const HOST = "https://adb-123.4.azuredatabricks.net";
const PROBE_URL = `${HOST}/api/ai-gateway/v2/endpoints?page_size=1`;
const SERVING_LIST_URL = `${HOST}/api/2.0/serving-endpoints`;
const FOUNDATION_LIST_URL = `${HOST}/api/2.0/serving-endpoints:foundation-models`;

const CREDENTIALS = {
	type: "apikey" as const,
	apiKey: "dapi-test-token",
	baseUrl: HOST,
};

/** Serving-endpoints list fixture covering every filter and stamp branch. */
const SERVING_ENDPOINTS_FIXTURE = {
	endpoints: [
		// FMAPI pay-per-token chat endpoint (foundation model) — native Anthropic
		{
			name: "databricks-claude-sonnet-4-5",
			task: "llm/v1/chat",
			state: { ready: "READY", config_update: "NOT_UPDATING" },
			config: {
				served_entities: [
					{
						foundation_model: {
							name: "databricks-claude-sonnet-4-5",
							display_name: "Claude Sonnet 4.5",
						},
					},
				],
			},
		},
		// Hosted Gemini pay-per-token endpoint — native generateContent (the
		// variant is reconstructable from the endpoint name)
		{
			name: "databricks-gemini-2-5-pro",
			task: "llm/v1/chat",
			state: { ready: "READY" },
			config: {
				served_entities: [
					{
						foundation_model: { name: "databricks-gemini-2-5-pro", display_name: "Gemini 2.5 Pro" },
					},
				],
			},
		},
		// External-model chat endpoint (task on the served entity, not top level)
		// with a Responses-compatible identity — native OpenAI Responses
		{
			name: "my-gpt-4o-gateway",
			state: { ready: "READY" },
			config: {
				served_entities: [
					{ external_model: { provider: "openai", name: "gpt-4o", task: "llm/v1/chat" } },
				],
			},
		},
		// Traffic-split endpoint whose entities resolve to different native
		// protocols — no unanimous native route, so the chat fallback is stamped
		{
			name: "mixed-vendor-split",
			task: "llm/v1/chat",
			state: { ready: "READY" },
			config: {
				served_entities: [
					{ foundation_model: { name: "databricks-claude-sonnet-4-5" } },
					{ external_model: { provider: "openai", name: "gpt-4o", task: "llm/v1/chat" } },
				],
			},
		},
		// Custom chat endpoint with an unrecognized underlying model
		{
			name: "my-custom-chat-model",
			task: "llm/v1/chat",
			state: { ready: "READY" },
			config: { served_entities: [{ entity_name: "main.models.my_custom_model" }] },
		},
		// Embeddings endpoint — excluded (not chat)
		{
			name: "databricks-gte-large-en",
			task: "llm/v1/embeddings",
			state: { ready: "READY" },
		},
		// Completions-only endpoint — excluded (not chat)
		{
			name: "legacy-completions",
			task: "llm/v1/completions",
			state: { ready: "READY" },
		},
		// Chat endpoint that is not ready — excluded
		{
			name: "provisioning-chat",
			task: "llm/v1/chat",
			state: { ready: "NOT_READY" },
		},
		// Custom endpoint with no task at all — excluded
		{
			name: "feature-serving-endpoint",
			state: { ready: "READY" },
		},
		// Route-optimized requires endpoint-scoped authorization_details — excluded.
		{
			name: "route-optimized-chat",
			route_optimized: true,
			task: "llm/v1/chat",
			state: { ready: "READY" },
		},
	],
};

/** Foundation-models list fixture (gateway discovery). */
const FOUNDATION_MODELS_FIXTURE = {
	endpoints: [
		// Advertises the native Anthropic Messages API alongside gateway chat
		{
			name: "databricks-claude-opus-4-8",
			config: {
				served_entities: [
					{
						foundation_model: {
							name: "databricks-claude-opus-4-8",
							display_name: "Claude Opus 4.8",
							api_types: [
								"mlflow/v1/chat/completions",
								"anthropic/v1/messages",
								"cursor/v1/chat/completions",
							],
							ai_gateway_v2_supported: true,
						},
					},
				],
			},
		},
		// Gateway chat only — the chat fallback
		{
			name: "databricks-llama-4-maverick",
			config: {
				served_entities: [
					{
						foundation_model: {
							name: "databricks-llama-4-maverick",
							display_name: "Llama 4 Maverick",
							api_types: ["mlflow/v1/chat/completions"],
							ai_gateway_v2_supported: true,
						},
					},
				],
			},
		},
		// Embeddings model — excluded (never advertises the chat api_type)
		{
			name: "databricks-gte-large-en",
			config: {
				served_entities: [
					{
						foundation_model: {
							name: "databricks-gte-large-en",
							api_types: ["mlflow/v1/embeddings"],
							ai_gateway_v2_supported: true,
						},
					},
				],
			},
		},
		// Chat api_type but no gateway v2 support — excluded
		{
			name: "legacy-v1-only-chat",
			config: {
				served_entities: [
					{
						foundation_model: {
							name: "legacy-v1-only-chat",
							api_types: ["mlflow/v1/chat/completions"],
							ai_gateway_v2_supported: false,
						},
					},
				],
			},
		},
		{
			name: "route-optimized-foundation",
			route_optimized: true,
			config: {
				served_entities: [
					{
						foundation_model: {
							name: "route-optimized-foundation",
							api_types: ["mlflow/v1/chat/completions"],
							ai_gateway_v2_supported: true,
						},
					},
				],
			},
		},
	],
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

interface CapturedChatRequest {
	url: string;
	headers: Headers;
}

/**
 * Stub global fetch with a workspace router: the gateway probe and the two
 * discovery lists serve fixtures (statuses are mutable so a sequence can be
 * scripted), and every other request is treated as a chat request — captured
 * and answered with a minimal event stream.
 */
function stubWorkspaceFetch(initial: {
	probeStatus: number;
	servingStatus?: number;
	foundationStatus?: number;
}) {
	const status = { ...initial };
	const chatRequests: CapturedChatRequest[] = [];

	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
		if (url === PROBE_URL) {
			return jsonResponse({ endpoints: [] }, status.probeStatus);
		}
		if (url === SERVING_LIST_URL) {
			return jsonResponse(SERVING_ENDPOINTS_FIXTURE, status.servingStatus ?? 200);
		}
		if (url === FOUNDATION_LIST_URL) {
			return jsonResponse(FOUNDATION_MODELS_FIXTURE, status.foundationStatus ?? 200);
		}
		chatRequests.push({
			url,
			headers: input instanceof Request ? new Headers(input.headers) : new Headers(init?.headers),
		});
		return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
	});
	vi.stubGlobal("fetch", fetchMock);

	return {
		fetchMock,
		status,
		chatRequests,
		urlsCalled: (): string[] =>
			fetchMock.mock.calls.map((call) => {
				const input = call[0];
				return typeof input === "string" || input instanceof URL ? input.toString() : input.url;
			}),
		probeCount: (): number =>
			fetchMock.mock.calls.filter((call) => String(call[0]) === PROBE_URL).length,
	};
}

/** Drive one chat request through the multiplexer, ignoring stream errors. */
async function runChat(
	client: ModelClient,
	params: { model: string; protocol?: Protocol; baseUrl?: string },
): Promise<void> {
	try {
		const stream = await client.chat({
			model: params.model,
			messages: [{ role: "user", content: "hello" }],
			protocol: params.protocol,
			baseUrl: params.baseUrl,
			cancellationToken,
		});
		for await (const _part of stream) {
			// Drain the (empty) mocked event stream.
		}
	} catch {
		// The mocked stream is minimal; stream errors are irrelevant — these tests
		// assert on the captured request.
	}
}

describe("parseServingEndpointsResponse", () => {
	it("keeps only READY chat-capable endpoints", () => {
		const models = parseServingEndpointsResponse(SERVING_ENDPOINTS_FIXTURE);

		expect(models.map((m) => m.id)).toEqual([
			"databricks-claude-sonnet-4-5",
			"databricks-gemini-2-5-pro",
			"my-gpt-4o-gateway",
			"mixed-vendor-split",
			"my-custom-chat-model",
		]);
	});

	it("stamps each endpoint with the protocol it will be routed over", () => {
		const models = parseServingEndpointsResponse(SERVING_ENDPOINTS_FIXTURE);
		const protocols = Object.fromEntries(models.map((m) => [m.id, m.protocol]));

		expect(protocols).toEqual({
			"databricks-claude-sonnet-4-5": "anthropic-messages",
			"databricks-gemini-2-5-pro": "google-generative",
			"my-gpt-4o-gateway": "openai-responses",
			// Entities disagree on the native protocol — explicit chat fallback.
			"mixed-vendor-split": "openai-chat",
			// Unrecognized model — explicit chat fallback, never an absent protocol.
			"my-custom-chat-model": "openai-chat",
		});
	});

	it("maps endpoint name to model id and foundation display name to model name", () => {
		const models = parseServingEndpointsResponse(SERVING_ENDPOINTS_FIXTURE);

		expect(models.find((m) => m.id === "databricks-claude-sonnet-4-5")).toMatchObject({
			id: "databricks-claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			providerId: "databricks",
			vendor: "anthropic",
		});
		expect(models.find((m) => m.id === "my-custom-chat-model")).toMatchObject({
			name: "my-custom-chat-model",
			vendor: "databricks",
		});
	});

	it("gives natively-routed models their vendor capabilities and degrades the chat fallback", () => {
		const models = parseServingEndpointsResponse(SERVING_ENDPOINTS_FIXTURE);
		const byId = (id: string) => models.find((m) => m.id === id);

		// The native `/v1/messages` route keeps the Anthropic table's limits and
		// thinking controls, but not PDF: Databricks documents native Messages
		// input as text + image.
		expect(byId("databricks-claude-sonnet-4-5")).toMatchObject({
			family: "claude-4.5",
			maxContextLength: 200_000,
			supportsImages: true,
		});
		expect(byId("databricks-claude-sonnet-4-5")?.supportedInputMediaTypes).toContain("image/png");
		expect(byId("databricks-claude-sonnet-4-5")?.supportedInputMediaTypes).not.toContain(
			"application/pdf",
		);
		// Thinking controls come back on the native Gemini route.
		expect(byId("databricks-gemini-2-5-pro")?.thinkingEffortLevels).toContain("high");

		// Chat-fallback endpoints stay on the degraded profile: no thinking
		// controls, and no PDF even for a Claude entity.
		expect(byId("mixed-vendor-split")?.thinkingEffortLevels).toBeUndefined();
		expect(byId("mixed-vendor-split")?.supportedInputMediaTypes).not.toContain("application/pdf");
		expect(byId("my-custom-chat-model")?.thinkingEffortLevels).toBeUndefined();
	});

	it("returns an empty list for a malformed response", () => {
		expect(parseServingEndpointsResponse({})).toEqual([]);
		expect(parseServingEndpointsResponse({ endpoints: [] })).toEqual([]);
	});
});

describe("parseFoundationModelsResponse", () => {
	it("lists only endpoints the gateway can actually route, stamped per advertised api_types", () => {
		const models = parseFoundationModelsResponse(FOUNDATION_MODELS_FIXTURE);

		expect(models.map((m) => [m.id, m.protocol])).toEqual([
			["databricks-claude-opus-4-8", "anthropic-messages"],
			["databricks-llama-4-maverick", "openai-chat"],
		]);
	});

	it("maps display names and infers capabilities from the foundation model name", () => {
		const models = parseFoundationModelsResponse(FOUNDATION_MODELS_FIXTURE);
		const opus = models.find((m) => m.id === "databricks-claude-opus-4-8");

		expect(opus).toMatchObject({
			name: "Claude Opus 4.8",
			providerId: "databricks",
			vendor: "anthropic",
			family: "claude-4.8",
			maxContextLength: 1_000_000,
			supportsImages: true,
		});
		expect(opus?.thinkingEffortLevels).toContain("high");
	});

	it("returns an empty list for a malformed response", () => {
		expect(parseFoundationModelsResponse({})).toEqual([]);
		expect(parseFoundationModelsResponse({ endpoints: [] })).toEqual([]);
	});
});

describe("registerDatabricksProvider model fetcher", () => {
	let registry: ProviderRegistry;

	beforeEach(() => {
		vi.clearAllMocks();
		registry = new ProviderRegistry(mockLogger);
		registerDatabricksProvider(registry, mockLogger);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses serving-endpoints discovery when the gateway probe returns 404", async () => {
		const workspace = stubWorkspaceFetch({ probeStatus: 404 });

		const models = await registry.getModelsForProvider("databricks", CREDENTIALS);

		expect(models.map((m) => m.id)).toContain("databricks-claude-sonnet-4-5");
		expect(workspace.urlsCalled()).toEqual([PROBE_URL, SERVING_LIST_URL]);
	});

	it("uses foundation-models discovery when the gateway probe succeeds", async () => {
		const workspace = stubWorkspaceFetch({ probeStatus: 200 });

		const models = await registry.getModelsForProvider("databricks", CREDENTIALS);

		expect(models.map((m) => m.id)).toEqual([
			"databricks-claude-opus-4-8",
			"databricks-llama-4-maverick",
		]);
		expect(workspace.urlsCalled()).toEqual([PROBE_URL, FOUNDATION_LIST_URL]);
	});

	it("probes once per registration and shares the pin with concurrent callers", async () => {
		const workspace = stubWorkspaceFetch({ probeStatus: 200 });

		const client = registry.getClientForProvider("databricks", CREDENTIALS);
		await Promise.all([
			registry.getModelsForProvider("databricks", CREDENTIALS),
			runChat(client, { model: "databricks-llama-4-maverick", protocol: "openai-chat" }),
		]);

		expect(workspace.probeCount()).toBe(1);
	});

	it("does not share the pin across independent registrations", async () => {
		const workspace = stubWorkspaceFetch({ probeStatus: 200 });

		await registry.getModelsForProvider("databricks", CREDENTIALS);

		const secondRegistry = new ProviderRegistry(mockLogger);
		registerDatabricksProvider(secondRegistry, mockLogger);
		await secondRegistry.getModelsForProvider("databricks", CREDENTIALS);

		expect(workspace.probeCount()).toBe(2);
	});

	it("sends a Bearer token and additive customHeaders on probe and discovery", async () => {
		const workspace = stubWorkspaceFetch({ probeStatus: 200 });

		await registry.getModelsForProvider("databricks", {
			...CREDENTIALS,
			customHeaders: { "x-databricks-use-coding-agent-mode": "true" },
		});

		for (const call of workspace.fetchMock.mock.calls) {
			expect(call[1]).toEqual({
				headers: {
					Authorization: "Bearer dapi-test-token",
					"x-databricks-use-coding-agent-mode": "true",
				},
			});
		}
	});

	it("normalizes a scheme-less workspace host", async () => {
		const workspace = stubWorkspaceFetch({ probeStatus: 404 });

		await registry.getModelsForProvider("databricks", {
			...CREDENTIALS,
			baseUrl: "adb-123.4.azuredatabricks.net/",
		});

		expect(workspace.urlsCalled()).toEqual([PROBE_URL, SERVING_LIST_URL]);
	});

	it("returns empty list when the API key is missing", async () => {
		const workspace = stubWorkspaceFetch({ probeStatus: 200 });

		const models = await registry.getModelsForProvider("databricks", {
			type: "apikey",
			apiKey: "",
			baseUrl: HOST,
		});

		expect(models).toEqual([]);
		expect(workspace.fetchMock).not.toHaveBeenCalled();
	});

	it("returns empty list when the workspace host is missing", async () => {
		const workspace = stubWorkspaceFetch({ probeStatus: 200 });

		const models = await registry.getModelsForProvider("databricks", {
			type: "apikey",
			apiKey: "dapi-test-token",
		});

		expect(models).toEqual([]);
		expect(workspace.fetchMock).not.toHaveBeenCalled();
	});

	it("returns empty list when the discovery call fails", async () => {
		stubWorkspaceFetch({ probeStatus: 404, servingStatus: 401 });

		const models = await registry.getModelsForProvider("databricks", CREDENTIALS);

		expect(models).toEqual([]);
	});
});

describe("registerDatabricksProvider surface pinning", () => {
	let registry: ProviderRegistry;

	beforeEach(() => {
		vi.clearAllMocks();
		registry = new ProviderRegistry(mockLogger);
		registerDatabricksProvider(registry, mockLogger);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("pins serving on a failed probe and keeps routing there until the model cache is cleared", async () => {
		const workspace = stubWorkspaceFetch({ probeStatus: 503 });

		// Discovery probes first, fails, and is pinned to serving — its stamps are
		// serving-qualified.
		const models = await registry.getModelsForProvider("databricks", CREDENTIALS);
		expect(models.map((m) => m.id)).toContain("databricks-claude-sonnet-4-5");

		// The workspace recovers: a fresh probe would now report gateway.
		workspace.status.probeStatus = 200;

		await runChat(registry.getClientForProvider("databricks", CREDENTIALS), {
			model: "databricks-claude-sonnet-4-5",
			protocol: "anthropic-messages",
		});

		// The pin holds: no serving-qualified stamp is routed down a gateway path,
		// and no second probe is fired.
		expect(workspace.chatRequests.map((r) => r.url)).toEqual([
			`${HOST}/serving-endpoints/anthropic/v1/messages`,
		]);
		expect(workspace.probeCount()).toBe(1);

		// Clearing the model cache releases the pin, so the recovered workspace can
		// be re-detected.
		registry.clearModelCache("databricks");
		await runChat(registry.getClientForProvider("databricks", CREDENTIALS), {
			model: "databricks-claude-opus-4-8",
			protocol: "anthropic-messages",
		});

		expect(workspace.probeCount()).toBe(2);
		expect(workspace.chatRequests.at(-1)?.url).toBe(`${HOST}/ai-gateway/anthropic/v1/messages`);
	});

	it("probes and pins from a chat request made before any discovery call", async () => {
		const workspace = stubWorkspaceFetch({ probeStatus: 200 });

		// No getModelsForProvider first — the registry allows chat without it.
		await runChat(registry.getClientForProvider("databricks", CREDENTIALS), {
			model: "databricks-llama-4-maverick",
			protocol: "openai-chat",
		});

		expect(workspace.chatRequests.map((r) => r.url)).toEqual([
			`${HOST}/ai-gateway/mlflow/v1/chat/completions`,
		]);

		// A later discovery reuses the pin the chat request established.
		const models = await registry.getModelsForProvider("databricks", CREDENTIALS);
		expect(models.map((m) => m.id)).toContain("databricks-claude-opus-4-8");
		expect(workspace.probeCount()).toBe(1);
	});

	// clearCache() must also invalidate work that is already awaiting the
	// network: a probe or list request issued under since-replaced credentials
	// may resolve after the clear and must not commit its result.
	it("ignores a probe that resolves after the cache was cleared", async () => {
		const probeResolvers: Array<(response: Response) => void> = [];
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
			if (url === PROBE_URL) {
				return new Promise<Response>((resolve) => probeResolvers.push(resolve));
			}
			if (url === SERVING_LIST_URL) {
				return jsonResponse(SERVING_ENDPOINTS_FIXTURE);
			}
			if (url === FOUNDATION_LIST_URL) {
				return jsonResponse(FOUNDATION_MODELS_FIXTURE);
			}
			return jsonResponse({ message: `unexpected URL: ${url}` }, 500);
		});
		vi.stubGlobal("fetch", fetchMock);

		// Discovery under the old credential: its probe hangs.
		const stale = registry.getModelsForProvider("databricks", CREDENTIALS);
		await vi.waitFor(() => expect(probeResolvers).toHaveLength(1));

		// Credential change: the caches are cleared and fresh work pins gateway.
		registry.clearModelCache("databricks");
		const fresh = registry.getModelsForProvider("databricks", CREDENTIALS);
		await vi.waitFor(() => expect(probeResolvers).toHaveLength(2));
		probeResolvers[1]?.(jsonResponse({ endpoints: [] }, 200));
		expect((await fresh).map((m) => m.id)).toContain("databricks-claude-opus-4-8");

		// The stale probe resolves last, reporting serving. It still answers its
		// own caller, but it must not re-pin the surface or clobber the cache.
		probeResolvers[0]?.(jsonResponse({ endpoints: [] }, 403));
		await stale;

		const after = await registry.getModelsForProvider("databricks", CREDENTIALS);
		expect(after.map((m) => m.id)).toContain("databricks-claude-opus-4-8");
		expect(fetchMock.mock.calls.filter((call) => String(call[0]) === PROBE_URL)).toHaveLength(2);
	});

	it("does not repopulate the model cache from a list fetch spanning clearCache", async () => {
		const listResolvers: Array<(response: Response) => void> = [];
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
			if (url === PROBE_URL) {
				return jsonResponse({ endpoints: [] }, 404);
			}
			if (url === SERVING_LIST_URL) {
				return new Promise<Response>((resolve) => listResolvers.push(resolve));
			}
			return jsonResponse({ message: `unexpected URL: ${url}` }, 500);
		});
		vi.stubGlobal("fetch", fetchMock);

		// The old-credential fetch pins serving, then hangs on the list request.
		const stale = registry.getModelsForProvider("databricks", CREDENTIALS);
		await vi.waitFor(() => expect(listResolvers).toHaveLength(1));

		registry.clearModelCache("databricks");
		listResolvers[0]?.(jsonResponse(SERVING_ENDPOINTS_FIXTURE));
		await stale;

		// The next fetch must go back to the network instead of being served the
		// stale list for the rest of the cache TTL.
		const fresh = registry.getModelsForProvider("databricks", CREDENTIALS);
		await vi.waitFor(() => expect(listResolvers).toHaveLength(2));
		listResolvers[1]?.(jsonResponse(SERVING_ENDPOINTS_FIXTURE));
		expect((await fresh).map((m) => m.id)).toContain("databricks-claude-sonnet-4-5");
	});
});

describe("registerDatabricksProvider route seam", () => {
	let registry: ProviderRegistry;

	beforeEach(() => {
		vi.clearAllMocks();
		registry = new ProviderRegistry(mockLogger);
		registerDatabricksProvider(registry, mockLogger);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/** Route one request and return the URL it landed on (query string dropped). */
	async function routedUrl(
		probeStatus: number,
		params: { model: string; protocol?: Protocol; baseUrl?: string },
	): Promise<string> {
		const workspace = stubWorkspaceFetch({ probeStatus });
		await runChat(registry.getClientForProvider("databricks", CREDENTIALS), params);
		const request = workspace.chatRequests[0];
		if (!request) throw new Error("no chat request was made");
		return request.url.split("?")[0];
	}

	it("routes each protocol to its serving-surface base", async () => {
		expect(
			await routedUrl(404, {
				model: "databricks-claude-sonnet-4-5",
				protocol: "anthropic-messages",
			}),
		).toBe(`${HOST}/serving-endpoints/anthropic/v1/messages`);
	});

	it("routes OpenAI Responses to the serving surface root", async () => {
		expect(await routedUrl(404, { model: "my-gpt-4o-gateway", protocol: "openai-responses" })).toBe(
			`${HOST}/serving-endpoints/responses`,
		);
	});

	it("routes Gemini generateContent to the serving surface v1beta base", async () => {
		expect(
			await routedUrl(404, { model: "databricks-gemini-2-5-pro", protocol: "google-generative" }),
		).toBe(
			`${HOST}/serving-endpoints/gemini/v1beta/models/databricks-gemini-2-5-pro:streamGenerateContent`,
		);
	});

	it("routes chat completions (and an absent protocol) to the serving surface root", async () => {
		expect(await routedUrl(404, { model: "my-custom-chat-model", protocol: "openai-chat" })).toBe(
			`${HOST}/serving-endpoints/chat/completions`,
		);

		registry = new ProviderRegistry(mockLogger);
		registerDatabricksProvider(registry, mockLogger);
		expect(await routedUrl(404, { model: "my-custom-chat-model" })).toBe(
			`${HOST}/serving-endpoints/chat/completions`,
		);
	});

	it("routes each protocol to its gateway-surface base", async () => {
		expect(
			await routedUrl(200, { model: "databricks-claude-opus-4-8", protocol: "anthropic-messages" }),
		).toBe(`${HOST}/ai-gateway/anthropic/v1/messages`);
	});

	it("routes gateway OpenAI Responses under /ai-gateway/openai/v1", async () => {
		expect(await routedUrl(200, { model: "my-gpt-4o-gateway", protocol: "openai-responses" })).toBe(
			`${HOST}/ai-gateway/openai/v1/responses`,
		);
	});

	it("routes gateway Gemini generateContent under /ai-gateway/gemini/v1beta", async () => {
		expect(
			await routedUrl(200, { model: "databricks-gemini-2-5-pro", protocol: "google-generative" }),
		).toBe(
			`${HOST}/ai-gateway/gemini/v1beta/models/databricks-gemini-2-5-pro:streamGenerateContent`,
		);
	});

	it("routes gateway chat completions under /ai-gateway/mlflow/v1", async () => {
		expect(
			await routedUrl(200, { model: "databricks-llama-4-maverick", protocol: "openai-chat" }),
		).toBe(`${HOST}/ai-gateway/mlflow/v1/chat/completions`);
	});

	it("trusts a pipeline-supplied base URL verbatim and skips the probe", async () => {
		const workspace = stubWorkspaceFetch({ probeStatus: 200 });

		await runChat(registry.getClientForProvider("databricks", CREDENTIALS), {
			model: "databricks-claude-sonnet-4-5",
			protocol: "anthropic-messages",
			baseUrl: "https://proxy.example.com/custom/anthropic/v1",
		});

		expect(workspace.chatRequests.map((r) => r.url)).toEqual([
			"https://proxy.example.com/custom/anthropic/v1/messages",
		]);
		expect(workspace.probeCount()).toBe(0);
	});

	it("rejects a protocol it cannot route, naming the model and protocol", async () => {
		stubWorkspaceFetch({ probeStatus: 404 });

		await expect(
			registry.getClientForProvider("databricks", CREDENTIALS).chat({
				model: "some-bedrock-model",
				messages: [{ role: "user", content: "hello" }],
				protocol: "bedrock-converse",
				cancellationToken,
			}),
		).rejects.toThrow(/some-bedrock-model.*bedrock-converse/);
	});
});

describe("registerDatabricksProvider auth and headers", () => {
	let registry: ProviderRegistry;

	beforeEach(() => {
		vi.clearAllMocks();
		registry = new ProviderRegistry(mockLogger);
		registerDatabricksProvider(registry, mockLogger);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/** Headers of the first chat request for one protocol, with custom headers set. */
	async function chatHeaders(params: { model: string; protocol: Protocol }): Promise<Headers> {
		const workspace = stubWorkspaceFetch({ probeStatus: 404 });
		await runChat(
			registry.getClientForProvider("databricks", {
				...CREDENTIALS,
				customHeaders: { "x-databricks-use-coding-agent-mode": "true" },
			}),
			params,
		);
		const request = workspace.chatRequests[0];
		if (!request) throw new Error("no chat request was made");
		return request.headers;
	}

	it("sends Bearer and additive custom headers on the Anthropic route, never x-api-key", async () => {
		const headers = await chatHeaders({
			model: "databricks-claude-sonnet-4-5",
			protocol: "anthropic-messages",
		});

		expect(headers.get("authorization")).toBe("Bearer dapi-test-token");
		expect(headers.get("x-api-key")).toBeNull();
		expect(headers.get("x-databricks-use-coding-agent-mode")).toBe("true");
	});

	it("sends Bearer and additive custom headers on the OpenAI routes", async () => {
		const headers = await chatHeaders({ model: "my-custom-chat-model", protocol: "openai-chat" });

		expect(headers.get("authorization")).toBe("Bearer dapi-test-token");
		expect(headers.get("x-databricks-use-coding-agent-mode")).toBe("true");
	});

	it("sends Bearer once and no x-goog-api-key on the Gemini route", async () => {
		const headers = await chatHeaders({
			model: "databricks-gemini-2-5-pro",
			protocol: "google-generative",
		});

		expect(headers.get("authorization")).toBe("Bearer dapi-test-token");
		// A duplicated header would surface as a comma-joined value.
		expect(headers.get("authorization")).not.toContain(",");
		expect(headers.has("x-goog-api-key")).toBe(false);
		expect(headers.get("x-databricks-use-coding-agent-mode")).toBe("true");
	});
});

describe("registerDatabricksProvider credential validation", () => {
	let registry: ProviderRegistry;

	beforeEach(() => {
		vi.clearAllMocks();
		registry = new ProviderRegistry(mockLogger);
		registerDatabricksProvider(registry, mockLogger);
	});

	it("throws for non-apikey credentials", () => {
		expect(() =>
			registry.getClientForProvider("databricks", {
				type: "oauth",
				accessToken: "some-token",
			}),
		).toThrow(/requires API key credentials/);
	});

	it("throws when the workspace host is missing", () => {
		expect(() =>
			registry.getClientForProvider("databricks", {
				type: "apikey",
				apiKey: "dapi-test-token",
			}),
		).toThrow(/workspace host/);
	});
});
