/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mintCustomProviderId } from "ai-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Logger, ProviderCredentials } from "../../types";
import { registerCustomAnthropicProvider } from "../anthropic-provider";
import { registerCustomBedrockProvider } from "../bedrock-provider";
import { registerCustomDeepSeekProvider } from "../deepseek-provider";
import { registerCustomFoundryProvider } from "../foundry-provider";
import { registerCustomGeminiProvider } from "../gemini-provider";
import { registerCustomGoogleVertexProvider } from "../google-vertex-provider";
import { registerCustomLMStudioProvider } from "../lmstudio-provider";
import { registerCustomOllamaProvider } from "../ollama-provider";
import { registerCustomOpenAIProvider } from "../openai-provider";
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

	it("makes every kind factory available without registering its built-in provider", () => {
		const cases: Array<{
			id: string;
			kind:
				| "anthropic"
				| "openai"
				| "gemini"
				| "deepseek"
				| "openrouter"
				| "ms-foundry"
				| "ollama"
				| "lmstudio"
				| "aws"
				| "google-vertex"
				| "snowflake";
			credentials: ProviderCredentials;
			register(registry: ProviderRegistry, id: ReturnType<typeof mintCustomProviderId>): void;
		}> = [
			{
				id: "custom-anthropic",
				kind: "anthropic",
				credentials: { type: "apikey", apiKey: "key" },
				register: (r, id) => registerCustomAnthropicProvider(r, id, logger),
			},
			{
				id: "custom-openai",
				kind: "openai",
				credentials: { type: "apikey", apiKey: "key" },
				register: (r, id) => registerCustomOpenAIProvider(r, id, logger),
			},
			{
				id: "custom-gemini",
				kind: "gemini",
				credentials: { type: "apikey", apiKey: "key" },
				register: (r, id) => registerCustomGeminiProvider(r, id, logger),
			},
			{
				id: "custom-deepseek",
				kind: "deepseek",
				credentials: { type: "apikey", apiKey: "key" },
				register: (r, id) => registerCustomDeepSeekProvider(r, id, logger),
			},
			{
				id: "custom-openrouter",
				kind: "openrouter",
				credentials: { type: "apikey", apiKey: "key" },
				register: (r, id) => registerCustomOpenRouterProvider(r, id, logger),
			},
			{
				id: "custom-foundry",
				kind: "ms-foundry",
				credentials: { type: "apikey", apiKey: "key", baseUrl: "https://foundry.example.com" },
				register: (r, id) => registerCustomFoundryProvider(r, id, logger),
			},
			{
				id: "custom-ollama",
				kind: "ollama",
				credentials: { type: "local", endpoint: "http://localhost:11434" },
				register: (r, id) => registerCustomOllamaProvider(r, id, logger),
			},
			{
				id: "custom-lmstudio",
				kind: "lmstudio",
				credentials: { type: "local", endpoint: "http://localhost:1234/v1" },
				register: (r, id) => registerCustomLMStudioProvider(r, id, logger),
			},
			{
				id: "custom-bedrock",
				kind: "aws",
				credentials: {
					type: "aws-credentials",
					region: "us-east-1",
					accessKeyId: "key",
					secretAccessKey: "secret",
				},
				register: (r, id) => registerCustomBedrockProvider(r, id, logger),
			},
			{
				id: "custom-vertex",
				kind: "google-vertex",
				credentials: {
					type: "google-cloud",
					project: "project",
					location: "us-central1",
					accessToken: "token",
				},
				register: (r, id) => registerCustomGoogleVertexProvider(r, id, logger),
			},
			{
				id: "custom-snowflake",
				kind: "snowflake",
				credentials: {
					type: "apikey",
					apiKey: "token",
					baseUrl: "https://account.snowflakecomputing.com",
				},
				register: (r, id) => registerCustomSnowflakeProvider(r, id, logger),
			},
		];

		for (const testCase of cases) {
			const registry = new ProviderRegistry(logger);
			const providerId = mintCustomProviderId(testCase.id);
			testCase.register(registry, providerId);
			expect(
				registry.getClientForProviderOrKind(providerId, testCase.credentials, testCase.kind),
				testCase.kind,
			).not.toBeNull();
		}
	});

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
			},
			{
				id: mintCustomProviderId("openai-http"),
				register: registerCustomOpenAIProvider,
				credentials: {
					type: "apikey",
					apiKey: "key",
					baseUrl: "https://openai.example.com/v1",
				} as const,
			},
			{
				id: mintCustomProviderId("gemini-http"),
				register: registerCustomGeminiProvider,
				credentials: {
					type: "apikey",
					apiKey: "key",
					baseUrl: "https://gemini.example.com/v1beta",
				} as const,
			},
			{
				id: mintCustomProviderId("openrouter-http"),
				register: registerCustomOpenRouterProvider,
				credentials: {
					type: "apikey",
					apiKey: "key",
					baseUrl: "https://openrouter.example.com",
				} as const,
			},
			{
				id: mintCustomProviderId("ollama-http"),
				register: registerCustomOllamaProvider,
				credentials: { type: "local", endpoint: "http://ollama.example.com" } as const,
			},
			{
				id: mintCustomProviderId("lmstudio-http"),
				register: registerCustomLMStudioProvider,
				credentials: { type: "local", endpoint: "http://lmstudio.example.com/v1" } as const,
			},
		];

		for (const testCase of cases) {
			testCase.register(registry, testCase.id, logger);
			const models = await registry.getModelsForProvider(testCase.id, testCase.credentials);
			expect(models, testCase.id).not.toHaveLength(0);
			expect(
				models.every((model) => model.providerId === testCase.id),
				testCase.id,
			).toBe(true);
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
