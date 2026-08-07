/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CancellationToken, Logger } from "../../types";
import {
	litellmV1BaseUrl,
	parseLitellmModelInfoResponse,
	registerLitellmProvider,
} from "../litellm-provider";
import { ProviderRegistry } from "../ProviderRegistry";

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
	const logger: Logger = {
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

	afterEach(() => {
		vi.unstubAllGlobals();
	});

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
					model_info: { litellm_provider: "anthropic", mode: "chat" },
				},
			],
		});
		expect(model.id).toBe("my-sonnet");
		expect(model.vendor).toBe("anthropic");
		expect(model.thinkingEffortLevels).toContain("high");
		expect(model.maxContextLength).toBe(1_000_000);
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

	it("maps non-Claude metadata without offering thinking levels", () => {
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
		expect(model.thinkingEffortLevels).toBeUndefined();
		expect(model.maxInputTokens).toBe(272_000);
		expect(model.maxOutputTokens).toBe(128_000);
		expect(model.supportsImages).toBe(true);
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
