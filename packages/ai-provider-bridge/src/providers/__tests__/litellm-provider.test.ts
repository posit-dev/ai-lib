/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mintCustomProviderId } from "ai-config";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelClientChatParams } from "../../model-clients/ModelClient";
import type { CancellationToken, Logger } from "../../types";
import {
	litellmV1BaseUrl,
	parseLitellmModelInfoResponse,
	registerCustomLitellmProvider,
	registerLitellmProvider,
} from "../litellm-provider";
import { ProviderRegistry } from "../ProviderRegistry";

const logger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("litellmV1BaseUrl", () => {
	it("appends /v1 to a bare proxy address", () => {
		expect(litellmV1BaseUrl("http://localhost:4000")).toBe("http://localhost:4000/v1");
	});

	it("tolerates trailing slashes and an existing /v1 segment", () => {
		expect(litellmV1BaseUrl("http://localhost:4000/")).toBe("http://localhost:4000/v1");
		expect(litellmV1BaseUrl("http://localhost:4000/v1")).toBe("http://localhost:4000/v1");
		expect(litellmV1BaseUrl("http://localhost:4000/v1/")).toBe("http://localhost:4000/v1");
	});
});

describe("litellm client factory", () => {
	const cancellationToken: CancellationToken = {
		isCancellationRequested: false,
		onCancellationRequested: () => ({ dispose() {} }),
	};

	it("normalizes a per-request baseUrl routing override to /v1", async () => {
		// The catalog pipeline forwards the raw connection baseUrl (e.g.
		// `http://localhost:4000`) as params.baseUrl, which wins over the
		// constructor URL inside AnthropicClient — unnormalized, chat would hit
		// `/messages` instead of `/v1/messages` and 404.
		const urls: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			urls.push(
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
			);
			return new Response(
				JSON.stringify({
					type: "error",
					error: { type: "invalid_request_error", message: "stop here" },
				}),
				{ status: 400, headers: { "content-type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const registry = new ProviderRegistry(logger);
		registerLitellmProvider(registry, logger);
		const client = registry.getClientForProvider("litellm", {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: "http://localhost:4000",
		});
		expect(client).not.toBeNull();

		try {
			const stream = await client!.chat({
				model: "claude-haiku-4-5",
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
				maxOutputTokens: 10,
				baseUrl: "http://localhost:4000",
				cancellationToken,
			});
			for await (const _part of stream) {
				// Drain; the mocked 400 surfaces as an error part or a throw.
			}
		} catch {
			// The mocked error response is expected — only the URL matters.
		}

		expect(urls[0]).toBe("http://localhost:4000/v1/messages");
	});

	interface CapturedRequest {
		url: string;
		headers: Headers;
	}

	/** Stub fetch, run one chat() with the given params, return the request. */
	async function captureChatRequest(
		params: Partial<ModelClientChatParams>,
		credentials: { apiKey: string; customHeaders?: Record<string, string> } = {
			apiKey: "sk-test",
		},
	): Promise<CapturedRequest> {
		const requests: CapturedRequest[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
			requests.push({ url, headers });
			return new Response(JSON.stringify({ error: { message: "stop here" } }), {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const registry = new ProviderRegistry(logger);
		registerLitellmProvider(registry, logger);
		const client = registry.getClientForProvider("litellm", {
			type: "apikey",
			baseUrl: "http://localhost:4000",
			...credentials,
		});
		expect(client).not.toBeNull();
		try {
			const stream = await client!.chat({
				model: "some-model",
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
				maxOutputTokens: 10,
				cancellationToken,
				...params,
			});
			for await (const _part of stream) {
				// Drain; the mocked 400 surfaces as an error part or a throw.
			}
		} catch {
			// Expected — only the captured request matters.
		}
		expect(requests.length).toBeGreaterThan(0);
		return requests[0];
	}

	it("dispatches anthropic-messages (and undefined) to the Anthropic delegate", async () => {
		const explicit = await captureChatRequest({ protocol: "anthropic-messages" });
		expect(explicit.url).toBe("http://localhost:4000/v1/messages");
		expect(explicit.headers.get("x-api-key")).toBe("sk-test");

		// Declared models.custom entries may omit protocol — undefined keeps
		// the v1 Anthropic-shaped route.
		const dflt = await captureChatRequest({});
		expect(dflt.url).toBe("http://localhost:4000/v1/messages");
	});

	it("dispatches openai-chat to /v1/chat/completions with Bearer auth", async () => {
		const req = await captureChatRequest({ protocol: "openai-chat" });
		expect(req.url).toBe("http://localhost:4000/v1/chat/completions");
		expect(req.headers.get("authorization")).toBe("Bearer sk-test");
	});

	it("dispatches openai-responses to /v1/responses with Bearer auth", async () => {
		const req = await captureChatRequest({ protocol: "openai-responses" });
		expect(req.url).toBe("http://localhost:4000/v1/responses");
		expect(req.headers.get("authorization")).toBe("Bearer sk-test");
	});

	it("normalizes legacy protocol values before dispatch", async () => {
		const req = await captureChatRequest({ protocol: "openai" });
		expect(req.url).toBe("http://localhost:4000/v1/chat/completions");
	});

	it("rejects protocols with no litellm route, naming the model", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}")),
		);
		const registry = new ProviderRegistry(logger);
		registerLitellmProvider(registry, logger);
		const client = registry.getClientForProvider("litellm", {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: "http://localhost:4000",
		});
		await expect(
			client!.chat({
				model: "some-model",
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
				maxOutputTokens: 10,
				cancellationToken,
				protocol: "bedrock-converse",
			}),
		).rejects.toThrow(/some-model.*bedrock-converse/);
	});

	it("forwards allowed custom headers to both delegates", async () => {
		const anthropicReq = await captureChatRequest(
			{ protocol: "anthropic-messages" },
			{ apiKey: "sk-test", customHeaders: { "X-Tenant": "acme" } },
		);
		expect(anthropicReq.headers.get("x-tenant")).toBe("acme");

		const openaiReq = await captureChatRequest(
			{ protocol: "openai-chat" },
			{ apiKey: "sk-test", customHeaders: { "X-Tenant": "acme" } },
		);
		expect(openaiReq.headers.get("x-tenant")).toBe("acme");
	});

	it("keeps custom headers flowing on the keyless OpenAI path while stripping Authorization", async () => {
		const req = await captureChatRequest(
			{ protocol: "openai-chat" },
			{ apiKey: "", customHeaders: { "X-Tenant": "acme" } },
		);
		expect(req.headers.get("x-tenant")).toBe("acme");
		expect(req.headers.get("authorization")).toBeNull();
	});
});

describe("litellm model fetcher", () => {
	it("requests model metadata from the normalized endpoint with both API key headers", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({ data: [{ model_name: "claude-haiku-4-5", model_info: { mode: "chat" } }] }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const registry = new ProviderRegistry(logger);
		registerLitellmProvider(registry, logger);

		const models = await registry.getModelsForProvider("litellm", {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: "http://localhost:4000/",
		});

		expect(models.map((model) => model.id)).toEqual(["claude-haiku-4-5"]);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/v1/model/info", {
			headers: {
				"x-api-key": "sk-test",
				Authorization: "Bearer sk-test",
			},
		});
	});
});

describe("registerCustomLitellmProvider", () => {
	it("stamps the custom provider id into discovered models", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({ data: [{ model_name: "claude-haiku-4-5", model_info: { mode: "chat" } }] }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const registry = new ProviderRegistry(logger);
		registerCustomLitellmProvider(registry, mintCustomProviderId("acme-ai"), logger);

		const models = await registry.getModelsForProvider("acme-ai", {
			type: "apikey",
			apiKey: "",
			baseUrl: "http://localhost:4000",
		});

		expect(models).toHaveLength(1);
		expect(models[0].providerId).toBe("acme-ai");
	});

	it("keeps independent model caches per gateway", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const alias = url.includes("gateway-a") ? "model-a" : "model-b";
			return Response.json({ data: [{ model_name: alias, model_info: { mode: "chat" } }] });
		});
		vi.stubGlobal("fetch", fetchMock);

		const registry = new ProviderRegistry(logger);
		registerCustomLitellmProvider(registry, mintCustomProviderId("acme-a"), logger);
		registerCustomLitellmProvider(registry, mintCustomProviderId("acme-b"), logger);

		const credsA = { type: "apikey", apiKey: "", baseUrl: "http://gateway-a:4000" } as const;
		const credsB = { type: "apikey", apiKey: "", baseUrl: "http://gateway-b:4000" } as const;

		// Two reads per provider: the second must serve from that provider's own
		// cache (one fetch per gateway), and each keeps its own model list.
		for (let i = 0; i < 2; i++) {
			const modelsA = await registry.getModelsForProvider("acme-a", credsA);
			const modelsB = await registry.getModelsForProvider("acme-b", credsB);
			expect(modelsA.map((m) => m.id)).toEqual(["model-a"]);
			expect(modelsB.map((m) => m.id)).toEqual(["model-b"]);
		}
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("resolves a chat client through the clientKind fallback without the built-in registrar", () => {
		const registry = new ProviderRegistry(logger);
		registerCustomLitellmProvider(registry, mintCustomProviderId("acme-ai"), logger);

		const client = registry.getClientForProviderOrKind(
			"acme-ai",
			{ type: "apikey", apiKey: "", baseUrl: "http://localhost:4000" },
			"litellm",
		);
		expect(client).not.toBeNull();
	});

	it("does not pin the custom id to the LiteLLM client when the entry's kind changes", () => {
		// Live-reload staleness regression: registrations are never removed, so a
		// factory keyed by the custom id would keep serving the LiteLLM client
		// after providers.json changes the entry's `type`. The factory must live
		// under the kind key only, letting routing follow the current catalog kind.
		const registry = new ProviderRegistry(logger);
		registerCustomLitellmProvider(registry, mintCustomProviderId("acme-ai"), logger);

		const openaiCompatibleClient = { chat: vi.fn() };
		registry.registerClientFactory("openai-compatible", () => openaiCompatibleClient);

		const client = registry.getClientForProviderOrKind(
			"acme-ai",
			{ type: "apikey", apiKey: "", baseUrl: "http://localhost:4000" },
			"openai-compatible",
		);
		expect(client).toBe(openaiCompatibleClient);
	});
});

describe("parseLitellmModelInfoResponse", () => {
	it("filters non-chat modes but keeps entries with unknown mode", () => {
		const models = parseLitellmModelInfoResponse({
			data: [
				{ model_name: "embedder", model_info: { mode: "embedding" } },
				{ model_name: "imagegen", model_info: { mode: "image_generation" } },
				{ model_name: "null-mode", model_info: { mode: null } },
				{ model_name: "no-info" },
			],
		});
		expect(models.map((m) => m.id)).toEqual(["null-mode", "no-info"]);
	});

	it("skips entries without a model_name", () => {
		const models = parseLitellmModelInfoResponse({
			data: [{ model_info: { mode: "chat" } }, { model_name: "ok" }],
		});
		expect(models.map((m) => m.id)).toEqual(["ok"]);
	});

	it("returns no models for an empty or shapeless response", () => {
		expect(parseLitellmModelInfoResponse({})).toEqual([]);
		expect(parseLitellmModelInfoResponse({ data: [] })).toEqual([]);
	});

	it("gives Claude aliases full Anthropic capabilities from the underlying model id", () => {
		const [model] = parseLitellmModelInfoResponse({
			data: [
				{
					model_name: "my-sonnet",
					litellm_params: { model: "anthropic/claude-sonnet-5-20251101" },
					model_info: {
						litellm_provider: "anthropic",
						mode: "chat",
						max_input_tokens: 200_000,
						max_output_tokens: 20_000,
					},
				},
			],
		});
		expect(model.id).toBe("my-sonnet");
		expect(model.vendor).toBe("anthropic");
		expect(model.thinkingEffortLevels).toContain("high");
		expect(model.maxInputTokens).toBe(200_000);
		expect(model.maxOutputTokens).toBe(20_000);
		expect(model.maxContextLength).toBe(200_000);
		expect(model.supportsImages).toBe(true);
		expect(model.supportsWebSearch).toBe(false);
	});

	it("detects Claude behind Bedrock inference-profile ids", () => {
		const [model] = parseLitellmModelInfoResponse({
			data: [
				{
					model_name: "bedrock-sonnet",
					litellm_params: { model: "bedrock/us.anthropic.claude-sonnet-4-6-20251001-v1:0" },
					model_info: { litellm_provider: "bedrock_converse", mode: "chat" },
				},
			],
		});
		expect(model.vendor).toBe("anthropic");
		expect(model.thinkingEffortLevels).toBeDefined();
	});

	it("detects Claude from the alias when litellm_params is missing", () => {
		const [model] = parseLitellmModelInfoResponse({
			data: [{ model_name: "claude-haiku-4-5" }],
		});
		expect(model.vendor).toBe("anthropic");
		expect(model.maxOutputTokens).toBe(64_000);
	});

	it("gives recognized OpenAI reasoning models thinking levels and the Responses route", () => {
		const [model] = parseLitellmModelInfoResponse({
			data: [
				{
					model_name: "gpt-5-mini",
					litellm_params: { model: "openai/gpt-5-mini" },
					model_info: {
						litellm_provider: "openai",
						mode: "chat",
						max_input_tokens: 272_000,
						max_output_tokens: 128_000,
						supports_vision: true,
					},
				},
			],
		});
		expect(model.vendor).toBe("openai");
		// The stateless encrypted-reasoning round-trip survives LiteLLM's
		// /v1/responses (empirically verified), so reasoning models keep
		// their thinking levels and route over openai-responses.
		expect(model.thinkingEffortLevels).toContain("high");
		expect(model.protocol).toBe("openai-responses");
		expect(model.maxInputTokens).toBe(272_000);
		expect(model.maxOutputTokens).toBe(128_000);
		expect(model.supportsImages).toBe(true);
	});

	it("routes non-reasoning OpenAI models over openai-chat", () => {
		const [model] = parseLitellmModelInfoResponse({
			data: [
				{
					model_name: "my-4o",
					litellm_params: { model: "openai/gpt-4o" },
					model_info: { litellm_provider: "openai", mode: "chat" },
				},
			],
		});
		expect(model.protocol).toBe("openai-chat");
		expect(model.thinkingEffortLevels).toBeUndefined();
	});

	it("stamps the per-family protocol on each alias", () => {
		const models = parseLitellmModelInfoResponse({
			data: [
				{
					model_name: "my-sonnet",
					litellm_params: { model: "anthropic/claude-sonnet-5" },
					model_info: { litellm_provider: "anthropic", mode: "chat" },
				},
				{
					model_name: "gemini-flash",
					litellm_params: { model: "gemini/gemini-2.5-flash" },
					model_info: { litellm_provider: "gemini", mode: "chat" },
				},
				{ model_name: "bare-alias" },
			],
		});
		expect(models.map((m) => [m.id, m.protocol])).toEqual([
			["my-sonnet", "anthropic-messages"],
			["gemini-flash", "openai-chat"],
			["bare-alias", "openai-chat"],
		]);
	});

	it("classifies a deceptive alias by its underlying id, not the alias", () => {
		const [model] = parseLitellmModelInfoResponse({
			data: [
				{
					model_name: "gpt-4o",
					litellm_params: { model: "gemini/gemini-2.5-flash" },
					model_info: { litellm_provider: "gemini", mode: "chat" },
				},
			],
		});
		expect(model.protocol).toBe("openai-chat");
		expect(model.thinkingEffortLevels).toBeUndefined();
		expect(model.vendor).toBe("gemini");
		// Conservative defaults, not the gpt-4o capability row.
		expect(model.maxContextLength).toBe(128_000);
	});

	it("falls back to conservative defaults when model_info is all null (Ollama-style)", () => {
		const [model] = parseLitellmModelInfoResponse({
			data: [
				{
					model_name: "qwen3-coder",
					litellm_params: { model: "ollama_chat/qwen3-coder:30b" },
					model_info: {
						litellm_provider: null,
						mode: null,
						max_input_tokens: null,
						max_output_tokens: null,
						supports_vision: null,
					},
				},
			],
		});
		expect(model.vendor).toBe("litellm");
		expect(model.maxInputTokens).toBe(128_000);
		expect(model.maxOutputTokens).toBe(16_384);
		expect(model.supportsImages).toBe(false);
		expect(model.thinkingEffortLevels).toBeUndefined();
	});
});
