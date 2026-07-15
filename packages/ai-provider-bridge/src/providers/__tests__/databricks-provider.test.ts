/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenAIClient } from "../../model-clients/OpenAIClient";
import type { Logger } from "../../types";
import {
	clearDatabricksGatewayModeCache,
	parseFoundationModelsResponse,
	parseServingEndpointsResponse,
	registerDatabricksProvider,
	rewriteServingUrlToGateway,
} from "../databricks-provider";
import { ProviderRegistry } from "../ProviderRegistry";

const mockLogger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
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

/** Serving-endpoints list fixture covering every filter branch. */
const SERVING_ENDPOINTS_FIXTURE = {
	endpoints: [
		// FMAPI pay-per-token chat endpoint (foundation model)
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
		// External-model chat endpoint (task on the served entity, not top level)
		{
			name: "my-gpt-4o-gateway",
			state: { ready: "READY" },
			config: {
				served_entities: [
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
	],
};

/** Foundation-models list fixture (gateway discovery) covering the api_types filter. */
const FOUNDATION_MODELS_FIXTURE = {
	endpoints: [
		// Chat-capable foundation model with gateway v2 support
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
		// Chat-capable open model
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
		// Embeddings model — excluded (no chat api_type)
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
	],
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * Stub global fetch with a URL router. `probeStatus` controls the gateway
 * availability probe; list URLs serve their fixtures.
 */
function stubRoutedFetch(options: {
	probeStatus: number;
	servingStatus?: number;
	foundationStatus?: number;
}): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async (input: string | URL | Request) => {
		const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
		if (url === PROBE_URL) {
			return jsonResponse({ endpoints: [] }, options.probeStatus);
		}
		if (url === SERVING_LIST_URL) {
			return jsonResponse(SERVING_ENDPOINTS_FIXTURE, options.servingStatus ?? 200);
		}
		if (url === FOUNDATION_LIST_URL) {
			return jsonResponse(FOUNDATION_MODELS_FIXTURE, options.foundationStatus ?? 200);
		}
		return jsonResponse({ message: `unexpected URL: ${url}` }, 500);
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function listUrlsCalled(fetchMock: ReturnType<typeof vi.fn>): string[] {
	return fetchMock.mock.calls.map((call) => {
		const input = call[0] as string | URL | Request;
		return typeof input === "string" || input instanceof URL ? input.toString() : input.url;
	});
}

describe("parseServingEndpointsResponse", () => {
	it("keeps only READY chat-capable endpoints", () => {
		const models = parseServingEndpointsResponse(SERVING_ENDPOINTS_FIXTURE);

		expect(models.map((m) => m.id)).toEqual([
			"databricks-claude-sonnet-4-5",
			"my-gpt-4o-gateway",
			"my-custom-chat-model",
		]);
	});

	it("maps endpoint name to model id and foundation display name to model name", () => {
		const models = parseServingEndpointsResponse(SERVING_ENDPOINTS_FIXTURE);
		const claude = models.find((m) => m.id === "databricks-claude-sonnet-4-5");

		expect(claude).toMatchObject({
			id: "databricks-claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			providerId: "databricks",
			vendor: "databricks",
			protocol: "openai",
		});
	});

	it("infers Claude capabilities from the foundation model name", () => {
		const models = parseServingEndpointsResponse(SERVING_ENDPOINTS_FIXTURE);
		const claude = models.find((m) => m.id === "databricks-claude-sonnet-4-5");

		expect(claude).toMatchObject({
			family: "claude-4.5",
			maxContextLength: 200_000,
			supportsImages: true,
			supportsToolResultImages: true,
		});
		// Thinking controls are not offered for Databricks in v1.
		expect(claude?.thinkingEffortLevels).toBeUndefined();
	});

	it("infers OpenAI capabilities from the external model name", () => {
		const models = parseServingEndpointsResponse(SERVING_ENDPOINTS_FIXTURE);
		const gpt = models.find((m) => m.id === "my-gpt-4o-gateway");

		expect(gpt).toMatchObject({
			family: "gpt-4o",
			maxContextLength: 128_000,
			supportsImages: true,
		});
		expect(gpt?.thinkingEffortLevels).toBeUndefined();
	});

	it("applies conservative defaults for unrecognized models", () => {
		const models = parseServingEndpointsResponse(SERVING_ENDPOINTS_FIXTURE);
		const custom = models.find((m) => m.id === "my-custom-chat-model");

		expect(custom).toMatchObject({
			name: "my-custom-chat-model",
			supportsTools: true,
			supportsImages: false,
			maxContextLength: 128_000,
			maxOutputTokens: 16_384,
		});
	});

	it("returns an empty list for a malformed response", () => {
		expect(parseServingEndpointsResponse({})).toEqual([]);
		expect(parseServingEndpointsResponse({ endpoints: [] })).toEqual([]);
	});
});

describe("parseFoundationModelsResponse", () => {
	it("keeps only gateway-v2 chat-capable models", () => {
		const models = parseFoundationModelsResponse(FOUNDATION_MODELS_FIXTURE);

		expect(models.map((m) => m.id)).toEqual([
			"databricks-claude-opus-4-8",
			"databricks-llama-4-maverick",
		]);
	});

	it("maps display names and infers capabilities from the foundation model name", () => {
		const models = parseFoundationModelsResponse(FOUNDATION_MODELS_FIXTURE);
		const opus = models.find((m) => m.id === "databricks-claude-opus-4-8");

		expect(opus).toMatchObject({
			name: "Claude Opus 4.8",
			providerId: "databricks",
			vendor: "databricks",
			protocol: "openai",
			family: "claude-4.8",
			maxContextLength: 1_000_000,
			supportsImages: true,
		});
		expect(opus?.thinkingEffortLevels).toBeUndefined();
	});

	it("returns an empty list for a malformed response", () => {
		expect(parseFoundationModelsResponse({})).toEqual([]);
		expect(parseFoundationModelsResponse({ endpoints: [] })).toEqual([]);
	});
});

describe("rewriteServingUrlToGateway", () => {
	it("rewrites the serving chat path to the gateway base path", () => {
		expect(rewriteServingUrlToGateway(`${HOST}/serving-endpoints/chat/completions`, HOST)).toBe(
			`${HOST}/ai-gateway/mlflow/v1/chat/completions`,
		);
	});

	it("leaves non-serving URLs untouched", () => {
		expect(rewriteServingUrlToGateway(`${HOST}/api/2.0/something`, HOST)).toBe(
			`${HOST}/api/2.0/something`,
		);
		expect(rewriteServingUrlToGateway("https://other.example.com/serving-endpoints/x", HOST)).toBe(
			"https://other.example.com/serving-endpoints/x",
		);
	});
});

describe("registerDatabricksProvider model fetcher", () => {
	let registry: ProviderRegistry;

	beforeEach(() => {
		vi.clearAllMocks();
		clearDatabricksGatewayModeCache();
		registry = new ProviderRegistry(mockLogger);
		registerDatabricksProvider(registry, mockLogger);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses serving-endpoints discovery when the gateway probe returns 404", async () => {
		const fetchMock = stubRoutedFetch({ probeStatus: 404 });

		const models = await registry.getModelsForProvider("databricks", CREDENTIALS);

		expect(models.map((m) => m.id)).toEqual([
			"databricks-claude-sonnet-4-5",
			"my-gpt-4o-gateway",
			"my-custom-chat-model",
		]);
		expect(listUrlsCalled(fetchMock)).toEqual([PROBE_URL, SERVING_LIST_URL]);
	});

	it("uses foundation-models discovery when the gateway probe succeeds", async () => {
		const fetchMock = stubRoutedFetch({ probeStatus: 200 });

		const models = await registry.getModelsForProvider("databricks", CREDENTIALS);

		expect(models.map((m) => m.id)).toEqual([
			"databricks-claude-opus-4-8",
			"databricks-llama-4-maverick",
		]);
		expect(listUrlsCalled(fetchMock)).toEqual([PROBE_URL, FOUNDATION_LIST_URL]);
	});

	it("falls back to serving mode without caching when the probe returns 5xx", async () => {
		const fetchMock = stubRoutedFetch({ probeStatus: 503 });

		const models = await registry.getModelsForProvider("databricks", CREDENTIALS);

		expect(models.map((m) => m.id)).toContain("databricks-claude-sonnet-4-5");
		expect(listUrlsCalled(fetchMock)).toEqual([PROBE_URL, SERVING_LIST_URL]);

		// A fresh fetcher (new registry, shared module cache) must probe again —
		// the transient failure was not cached as a definitive answer.
		const secondRegistry = new ProviderRegistry(mockLogger);
		registerDatabricksProvider(secondRegistry, mockLogger);
		await secondRegistry.getModelsForProvider("databricks", CREDENTIALS);
		expect(listUrlsCalled(fetchMock).filter((u) => u === PROBE_URL)).toHaveLength(2);
	});

	it("caches the definitive gateway probe result across fetcher instances", async () => {
		const fetchMock = stubRoutedFetch({ probeStatus: 200 });

		await registry.getModelsForProvider("databricks", CREDENTIALS);

		const secondRegistry = new ProviderRegistry(mockLogger);
		registerDatabricksProvider(secondRegistry, mockLogger);
		await secondRegistry.getModelsForProvider("databricks", CREDENTIALS);

		expect(listUrlsCalled(fetchMock).filter((u) => u === PROBE_URL)).toHaveLength(1);
	});

	it("sends a Bearer token and additive customHeaders on probe and discovery", async () => {
		const fetchMock = stubRoutedFetch({ probeStatus: 200 });

		await registry.getModelsForProvider("databricks", {
			...CREDENTIALS,
			customHeaders: { "x-databricks-use-coding-agent-mode": "true" },
		});

		for (const call of fetchMock.mock.calls) {
			expect(call[1]).toEqual({
				headers: {
					Authorization: "Bearer dapi-test-token",
					"x-databricks-use-coding-agent-mode": "true",
				},
			});
		}
	});

	it("normalizes a scheme-less workspace host", async () => {
		const fetchMock = stubRoutedFetch({ probeStatus: 404 });

		await registry.getModelsForProvider("databricks", {
			...CREDENTIALS,
			baseUrl: "adb-123.4.azuredatabricks.net/",
		});

		expect(listUrlsCalled(fetchMock)).toEqual([PROBE_URL, SERVING_LIST_URL]);
	});

	it("returns empty list when the API key is missing", async () => {
		const fetchMock = stubRoutedFetch({ probeStatus: 200 });

		const models = await registry.getModelsForProvider("databricks", {
			type: "apikey",
			apiKey: "",
			baseUrl: HOST,
		});

		expect(models).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns empty list when the workspace host is missing", async () => {
		const fetchMock = stubRoutedFetch({ probeStatus: 200 });

		const models = await registry.getModelsForProvider("databricks", {
			type: "apikey",
			apiKey: "dapi-test-token",
		});

		expect(models).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns empty list when the discovery call fails", async () => {
		stubRoutedFetch({ probeStatus: 404, servingStatus: 401 });

		const models = await registry.getModelsForProvider("databricks", CREDENTIALS);

		expect(models).toEqual([]);
	});
});

describe("registerDatabricksProvider client factory", () => {
	let registry: ProviderRegistry;

	beforeEach(() => {
		vi.clearAllMocks();
		clearDatabricksGatewayModeCache();
		registry = new ProviderRegistry(mockLogger);
		registerDatabricksProvider(registry, mockLogger);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("creates an OpenAI-compatible client for apikey credentials", () => {
		const client = registry.getClientForProvider("databricks", CREDENTIALS);

		expect(client).toBeInstanceOf(OpenAIClient);
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
