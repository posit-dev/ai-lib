/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mintCustomProviderId } from "ai-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../../types";
import { registerAnthropicProvider, registerCustomAnthropicProvider } from "../anthropic-provider";
import { registerCustomDeepSeekProvider } from "../deepseek-provider";
import { registerCustomFoundryProvider } from "../foundry-provider";
import { registerCustomGeminiProvider, registerGeminiProvider } from "../gemini-provider";
import { registerCustomLMStudioProvider } from "../lmstudio-provider";
import { registerCustomOllamaProvider } from "../ollama-provider";
import { registerCustomOpenAIProvider, registerOpenAIProvider } from "../openai-provider";
import { registerCustomOpenRouterProvider } from "../openrouter-provider";
import { ProviderRegistry } from "../ProviderRegistry";
import { registerCustomSnowflakeProvider } from "../snowflake-cortex-provider";

const logger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

describe("custom provider registrars", () => {
	beforeEach(() => vi.clearAllMocks());
	afterEach(() => vi.unstubAllGlobals());

	it("keeps discovery caches independent for two custom IDs of one kind", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: [{ id: "deepseek-chat", object: "model", owned_by: "deepseek" }],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		const registry = new ProviderRegistry(logger);
		const first = mintCustomProviderId("deepseek-one");
		const second = mintCustomProviderId("deepseek-two");
		registerCustomDeepSeekProvider(registry, first, logger);
		registerCustomDeepSeekProvider(registry, second, logger);

		const firstModels = await registry.getModelsForProvider(first, {
			type: "apikey",
			apiKey: "key-one",
			baseUrl: "https://one.example.com",
		});
		const secondModels = await registry.getModelsForProvider(second, {
			type: "apikey",
			apiKey: "key-two",
			baseUrl: "https://two.example.com/v1",
		});
		await registry.getModelsForProvider(first, {
			type: "apikey",
			apiKey: "key-one",
			baseUrl: "https://one.example.com",
		});

		expect(firstModels[0]?.providerId).toBe(first);
		expect(secondModels[0]?.providerId).toBe(second);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
			"https://one.example.com/models",
			"https://two.example.com/v1/models",
		]);
	});

	it("discovers HTTP-backed models under each custom provider ID", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				let body: unknown;
				if (url.includes("anthropic.example.com")) {
					body = { data: [{ id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" }] };
				} else if (url.includes("openai.example.com")) {
					body = { data: [{ id: "gpt-5.4", object: "model", owned_by: "openai" }] };
				} else if (url.includes("gemini.example.com")) {
					body = { models: [{ name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" }] };
				} else if (url.includes("openrouter.example.com")) {
					body = {
						data: [
							{
								id: "anthropic/claude-sonnet-4.6",
								name: "Claude Sonnet 4.6",
								context_length: 200000,
								pricing: { prompt: "0", completion: "0" },
								architecture: { modality: "text->text", tokenizer: "Claude" },
								supported_parameters: ["tools"],
							},
						],
					};
				} else if (url.endsWith("/api/tags")) {
					body = { models: [{ name: "qwen3:latest", size: 1, details: { family: "qwen" } }] };
				} else if (url.endsWith("/api/show")) {
					body = { capabilities: ["tools", "thinking"], parameters: "num_ctx 32768" };
				} else {
					body = {
						data: [{ id: "local-model", object: "model", owned_by: "local", permission: [] }],
					};
				}
				return new Response(JSON.stringify(body), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}),
		);

		const registry = new ProviderRegistry(logger);
		const cases = [
			{
				id: mintCustomProviderId("anthropic-http"),
				register: registerCustomAnthropicProvider,
				credentials: {
					type: "apikey",
					apiKey: "key",
					baseUrl: "https://anthropic.example.com/v1",
				} as const,
				expectedModelIds: ["claude-sonnet-4-6"],
			},
			{
				id: mintCustomProviderId("openai-http"),
				register: registerCustomOpenAIProvider,
				credentials: {
					type: "apikey",
					apiKey: "key",
					baseUrl: "https://openai.example.com/v1",
				} as const,
				expectedModelIds: ["gpt-5.4"],
			},
			{
				id: mintCustomProviderId("gemini-http"),
				register: registerCustomGeminiProvider,
				credentials: {
					type: "apikey",
					apiKey: "key",
					baseUrl: "https://gemini.example.com/v1beta",
				} as const,
				expectedModelIds: ["gemini-2.5-pro"],
			},
			{
				id: mintCustomProviderId("openrouter-http"),
				register: registerCustomOpenRouterProvider,
				credentials: {
					type: "apikey",
					apiKey: "key",
					baseUrl: "https://openrouter.example.com",
				} as const,
				expectedModelIds: ["anthropic/claude-sonnet-4.6"],
			},
			{
				id: mintCustomProviderId("ollama-http"),
				register: registerCustomOllamaProvider,
				credentials: { type: "local", endpoint: "http://ollama.example.com" } as const,
				expectedModelIds: ["qwen3:latest"],
			},
			{
				id: mintCustomProviderId("lmstudio-http"),
				register: registerCustomLMStudioProvider,
				credentials: { type: "local", endpoint: "http://lmstudio.example.com/v1" } as const,
				expectedModelIds: ["local-model"],
			},
		];

		for (const testCase of cases) {
			testCase.register(registry, testCase.id, logger);
			const models = await registry.getModelsForProvider(testCase.id, testCase.credentials);
			expect(
				models.map((model) => model.id),
				testCase.id,
			).toEqual(testCase.expectedModelIds);
			expect(
				models.every((model) => model.providerId === testCase.id),
				testCase.id,
			).toBe(true);
		}
	});

	it("does not substitute hosted fallbacks when custom OpenAI or Gemini discovery fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 503 })),
		);
		const registry = new ProviderRegistry(logger);
		const openai = mintCustomProviderId("openai-failure");
		const gemini = mintCustomProviderId("gemini-failure");
		registerCustomOpenAIProvider(registry, openai, logger);
		registerCustomGeminiProvider(registry, gemini, logger);

		expect(
			await registry.getModelsForProvider(openai, {
				type: "apikey",
				apiKey: "key",
				baseUrl: "https://openai.example.com/v1",
			}),
		).toEqual([]);
		expect(
			await registry.getModelsForProvider(gemini, {
				type: "apikey",
				apiKey: "key",
				baseUrl: "https://gemini.example.com/v1beta",
			}),
		).toEqual([]);
	});

	it("retains supplemental and fallback models for built-in hosted providers", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				if (String(input).includes("api.anthropic.com")) {
					return new Response(JSON.stringify({ data: [] }), { status: 200 });
				}
				return new Response(null, { status: 503 });
			}),
		);
		const registry = new ProviderRegistry(logger);
		registerAnthropicProvider(registry, logger);
		registerOpenAIProvider(registry, logger);
		registerGeminiProvider(registry, logger);

		expect(
			(await registry.getModelsForProvider("anthropic", { type: "apikey", apiKey: "key" })).map(
				(model) => model.id,
			),
		).toEqual(["claude-opus-5", "claude-fable-5"]);
		expect(
			await registry.getModelsForProvider("openai", { type: "apikey", apiKey: "key" }),
		).not.toHaveLength(0);

		const geminiFallbacks = await registry.getModelsForProvider("gemini", {
			type: "apikey",
			apiKey: "key",
		});
		// Exact fallback row identity (id + name, in order) is the contract
		// unique to this path. Capability-field coverage lives in the dynamic
		// /models test (gemini-provider.test.ts) and the ai-config infer tests,
		// which exercise the same buildGeminiModel construction — duplicating
		// it here would force lockstep test edits on every capability change.
		expect(geminiFallbacks.map((model) => ({ id: model.id, name: model.name }))).toEqual([
			{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
			{ id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
			{ id: "gemma-4-31b-it", name: "Gemma 4 31B IT" },
			{ id: "gemma-4-26b-a4b-it", name: "Gemma 4 26B A4B IT" },
		]);
		// Every fallback row is well-formed and attributed to the provider.
		for (const model of geminiFallbacks) {
			expect(model.providerId).toBe("gemini");
			expect(model.supportsTools).toBe(true);
			expect(model.maxContextLength).toBeGreaterThan(0);
		}
	});

	it("discovers static custom Foundry and Snowflake models under the custom ID", async () => {
		const registry = new ProviderRegistry(logger);
		const foundry = mintCustomProviderId("custom-foundry");
		const snowflake = mintCustomProviderId("custom-snowflake");
		registerCustomFoundryProvider(registry, foundry, logger);
		registerCustomSnowflakeProvider(registry, snowflake, logger);

		expect(
			await registry.getModelsForProvider(foundry, {
				type: "apikey",
				apiKey: "key",
				baseUrl: "https://foundry.example.com",
			}),
		).toEqual([expect.objectContaining({ id: "model-router", providerId: foundry })]);
		expect(
			await registry.getModelsForProvider(snowflake, {
				type: "apikey",
				apiKey: "token",
				baseUrl: "https://account.snowflakecomputing.com",
			}),
		).toEqual(expect.arrayContaining([expect.objectContaining({ providerId: snowflake })]));
	});
});
