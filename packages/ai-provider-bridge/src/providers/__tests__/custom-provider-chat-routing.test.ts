/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ClientKind, ResolvedProviderId } from "ai-config";
import { mintCustomProviderId } from "ai-config";
import { beforeEach, describe, expect, it, vi } from "vitest";

const chats = vi.hoisted(() => ({
	anthropic: vi.fn(async () => (async function* () {})()),
	bedrock: vi.fn(async () => (async function* () {})()),
	deepseek: vi.fn(async () => (async function* () {})()),
	gemini: vi.fn(async () => (async function* () {})()),
	googleVertex: vi.fn(async () => (async function* () {})()),
	lmstudio: vi.fn(async () => (async function* () {})()),
	ollama: vi.fn(async () => (async function* () {})()),
	openai: vi.fn(async () => (async function* () {})()),
	openrouter: vi.fn(async () => (async function* () {})()),
	snowflake: vi.fn(async () => (async function* () {})()),
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
vi.mock("../../model-clients/DeepSeekClient", () => ({
	DeepSeekClient: vi.fn(function () {
		return { chat: chats.deepseek };
	}),
}));
vi.mock("../../model-clients/GeminiClient", () => ({
	GeminiClient: vi.fn(function () {
		return { chat: chats.gemini };
	}),
}));
vi.mock("../../model-clients/GoogleVertexClient", () => ({
	GoogleVertexClient: vi.fn(function () {
		return { chat: chats.googleVertex };
	}),
}));
vi.mock("../../model-clients/LMStudioClient", () => ({
	LMStudioClient: vi.fn(function () {
		return { chat: chats.lmstudio };
	}),
}));
vi.mock("../../model-clients/OllamaClient", () => ({
	OllamaClient: vi.fn(function () {
		return { chat: chats.ollama };
	}),
}));
vi.mock("../../model-clients/OpenAIClient", () => ({
	OpenAIClient: vi.fn(function () {
		return { chat: chats.openai };
	}),
}));
vi.mock("../../model-clients/OpenRouterClient", () => ({
	OpenRouterClient: vi.fn(function () {
		return { chat: chats.openrouter };
	}),
}));
vi.mock("../../model-clients/SnowflakeClient", () => ({
	SnowflakeClient: vi.fn(function () {
		return { chat: chats.snowflake };
	}),
}));

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

type ChatSpy = (typeof chats)[keyof typeof chats];

interface RoutingCase {
	name: string;
	id: ResolvedProviderId;
	kind: ClientKind;
	credentials: ProviderCredentials;
	register(registry: ProviderRegistry, providerId: ResolvedProviderId, logger: Logger): void;
	chat: ChatSpy;
}

const ROUTING_CASES = [
	{
		name: "Anthropic",
		id: mintCustomProviderId("custom-anthropic"),
		kind: "anthropic",
		credentials: { type: "apikey", apiKey: "key" },
		register: registerCustomAnthropicProvider,
		chat: chats.anthropic,
	},
	{
		name: "OpenAI",
		id: mintCustomProviderId("custom-openai"),
		kind: "openai",
		credentials: { type: "apikey", apiKey: "key" },
		register: registerCustomOpenAIProvider,
		chat: chats.openai,
	},
	{
		name: "Gemini",
		id: mintCustomProviderId("custom-gemini"),
		kind: "gemini",
		credentials: { type: "apikey", apiKey: "key" },
		register: registerCustomGeminiProvider,
		chat: chats.gemini,
	},
	{
		name: "DeepSeek",
		id: mintCustomProviderId("custom-deepseek"),
		kind: "deepseek",
		credentials: { type: "apikey", apiKey: "key" },
		register: registerCustomDeepSeekProvider,
		chat: chats.deepseek,
	},
	{
		name: "OpenRouter",
		id: mintCustomProviderId("custom-openrouter"),
		kind: "openrouter",
		credentials: { type: "apikey", apiKey: "key" },
		register: registerCustomOpenRouterProvider,
		chat: chats.openrouter,
	},
	{
		name: "Foundry",
		id: mintCustomProviderId("custom-foundry"),
		kind: "ms-foundry",
		credentials: { type: "apikey", apiKey: "key", baseUrl: "https://foundry.test" },
		register: registerCustomFoundryProvider,
		chat: chats.openai,
	},
	{
		name: "Ollama",
		id: mintCustomProviderId("custom-ollama"),
		kind: "ollama",
		credentials: { type: "local", endpoint: "http://ollama.test" },
		register: registerCustomOllamaProvider,
		chat: chats.ollama,
	},
	{
		name: "LM Studio",
		id: mintCustomProviderId("custom-lmstudio"),
		kind: "lmstudio",
		credentials: { type: "local", endpoint: "http://lmstudio.test/v1" },
		register: registerCustomLMStudioProvider,
		chat: chats.lmstudio,
	},
	{
		name: "Amazon Bedrock",
		id: mintCustomProviderId("custom-aws"),
		kind: "aws",
		credentials: { type: "aws-credentials", region: "us-east-1" },
		register: registerCustomBedrockProvider,
		chat: chats.bedrock,
	},
	{
		name: "Google Vertex",
		id: mintCustomProviderId("custom-vertex"),
		kind: "google-vertex",
		credentials: { type: "google-cloud", project: "project" },
		register: registerCustomGoogleVertexProvider,
		chat: chats.googleVertex,
	},
	{
		name: "Snowflake",
		id: mintCustomProviderId("custom-snowflake"),
		kind: "snowflake",
		credentials: {
			type: "apikey",
			apiKey: "token",
			baseUrl: "https://snowflake.test",
		},
		register: registerCustomSnowflakeProvider,
		chat: chats.snowflake,
	},
] satisfies readonly RoutingCase[];

describe("custom provider chat routing", () => {
	beforeEach(() => vi.clearAllMocks());

	it.each(ROUTING_CASES)(
		"$name routes its custom kind through ProviderRegistry with the built-in disabled",
		async (testCase) => {
			const registry = new ProviderRegistry(logger);
			testCase.register(registry, testCase.id, logger);
			const client = registry.getClientForProviderOrKind(
				testCase.id,
				testCase.credentials,
				testCase.kind,
			);
			if (!client) throw new Error(`expected a routed client for ${testCase.kind}`);

			await client.chat({
				model: "test-model",
				messages: [{ role: "user", content: "hello" }],
				cancellationToken: {
					isCancellationRequested: false,
					onCancellationRequested: () => ({ dispose() {} }),
				},
			});

			expect(testCase.chat, testCase.kind).toHaveBeenCalledOnce();
		},
	);
});
