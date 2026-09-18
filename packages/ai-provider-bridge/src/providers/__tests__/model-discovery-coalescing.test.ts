/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per-provider wiring tests for the registry-owned in-flight request
 * coalescer: every provider whose discovery is a single GET registers its
 * fetcher with `requestCoalescer`, so the same backend configured under two
 * provider ids (built-in plus a custom entry) issues ONE base-list request
 * for concurrent discovery instead of two. The coalescer contract itself
 * (barriers, cancellation, isolation) is covered in request-coalescer.test.ts;
 * these tests prove each provider actually opts in, and that URL-carried
 * credentials (Gemini's `?key=`) shape the identity through their hash rather
 * than being retained in it.
 */

import { mintCustomProviderId } from "ai-config";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Logger, ModelInfo, ProviderCredentials } from "../../types";
import { registerAnthropicProvider, registerCustomAnthropicProvider } from "../anthropic-provider";
import { createCachedModelFetcher } from "../cached-model-fetcher";
import { registerDeepSeekProvider, registerCustomDeepSeekProvider } from "../deepseek-provider";
import { registerGeminiProvider, registerCustomGeminiProvider } from "../gemini-provider";
import { registerLMStudioProvider, registerCustomLMStudioProvider } from "../lmstudio-provider";
import { registerOllamaProvider, registerCustomOllamaProvider } from "../ollama-provider";
import {
	registerOpenAICompatibleProvider,
	registerCustomOpenAICompatibleProvider,
} from "../openai-compatible-provider";
import { registerOpenAIProvider, registerCustomOpenAIProvider } from "../openai-provider";
import {
	registerOpenRouterProvider,
	registerCustomOpenRouterProvider,
} from "../openrouter-provider";
import { ProviderRegistry } from "../ProviderRegistry";
import type { ModelRequestIdentity } from "../request-coalescer";
import { fingerprintHeaders } from "../request-coalescer";

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

interface CoalescingCase {
	readonly name: string;
	readonly builtinId: string;
	readonly customId: string;
	readonly registerBoth: (registry: ProviderRegistry, customId: string) => void;
	readonly credentials: ProviderCredentials;
	/** Minimal payload that parses to at least one model. */
	readonly payload: object;
	/** Substring identifying the base model-list request (not enrichment). */
	readonly listUrlFragment: string;
}

const CASES: CoalescingCase[] = [
	{
		name: "openai-compatible",
		builtinId: "openai-compatible",
		customId: "dup-oai-compat",
		registerBoth: (registry, customId) => {
			registerOpenAICompatibleProvider(registry, logger);
			registerCustomOpenAICompatibleProvider(registry, mintCustomProviderId(customId), logger);
		},
		credentials: { type: "apikey", apiKey: "sk-same", baseUrl: "http://dup:8000/v1" },
		payload: { data: [{ id: "test-model" }] },
		listUrlFragment: "/models",
	},
	{
		name: "openai",
		builtinId: "openai",
		customId: "dup-openai",
		registerBoth: (registry, customId) => {
			registerOpenAIProvider(registry, logger);
			registerCustomOpenAIProvider(registry, mintCustomProviderId(customId), logger);
		},
		credentials: { type: "apikey", apiKey: "sk-same", baseUrl: "http://dup:8000/v1" },
		payload: { data: [{ id: "gpt-5-mini", object: "model", owned_by: "openai" }] },
		listUrlFragment: "/models",
	},
	{
		name: "ollama",
		builtinId: "ollama",
		customId: "dup-ollama",
		registerBoth: (registry, customId) => {
			registerOllamaProvider(registry, logger);
			registerCustomOllamaProvider(registry, mintCustomProviderId(customId), logger);
		},
		credentials: { type: "local", endpoint: "http://dup:11434" },
		payload: { models: [{ name: "llama3.2:latest", size: 1, details: { family: "llama" } }] },
		listUrlFragment: "/api/tags",
	},
	{
		name: "lmstudio",
		builtinId: "lmstudio",
		customId: "dup-lmstudio",
		registerBoth: (registry, customId) => {
			registerLMStudioProvider(registry, logger);
			registerCustomLMStudioProvider(registry, mintCustomProviderId(customId), logger);
		},
		credentials: { type: "local", endpoint: "http://dup:1234/v1" },
		payload: {
			data: [{ id: "qwen2.5-7b-instruct", object: "model", owned_by: "local", permission: [] }],
		},
		listUrlFragment: "/models",
	},
	{
		name: "openrouter",
		builtinId: "openrouter",
		customId: "dup-openrouter",
		registerBoth: (registry, customId) => {
			registerOpenRouterProvider(registry, logger);
			registerCustomOpenRouterProvider(registry, mintCustomProviderId(customId), logger);
		},
		credentials: { type: "apikey", apiKey: "sk-same" },
		payload: { data: [{ id: "openai/gpt-5", architecture: { modality: "text->text" } }] },
		listUrlFragment: "/models",
	},
	{
		name: "anthropic",
		builtinId: "anthropic",
		customId: "dup-anthropic",
		registerBoth: (registry, customId) => {
			registerAnthropicProvider(registry, logger);
			registerCustomAnthropicProvider(registry, mintCustomProviderId(customId), logger);
		},
		credentials: { type: "apikey", apiKey: "sk-same" },
		payload: { data: [{ id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" }] },
		listUrlFragment: "/models",
	},
	{
		name: "deepseek",
		builtinId: "deepseek",
		customId: "dup-deepseek",
		registerBoth: (registry, customId) => {
			registerDeepSeekProvider(registry, logger);
			registerCustomDeepSeekProvider(registry, mintCustomProviderId(customId), logger);
		},
		credentials: { type: "apikey", apiKey: "sk-same" },
		payload: { data: [{ id: "deepseek-chat", object: "model", owned_by: "deepseek" }] },
		listUrlFragment: "/models",
	},
	{
		name: "gemini",
		builtinId: "gemini",
		customId: "dup-gemini",
		registerBoth: (registry, customId) => {
			registerGeminiProvider(registry, logger);
			registerCustomGeminiProvider(registry, mintCustomProviderId(customId), logger);
		},
		credentials: { type: "apikey", apiKey: "gem-key-same" },
		payload: {
			models: [
				{
					name: "models/gemini-2.5-flash",
					displayName: "Gemini 2.5 Flash",
					supportedGenerationMethods: ["generateContent"],
				},
			],
		},
		listUrlFragment: "/models",
	},
];

function urlOf(input: string | URL | Request): string {
	return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

describe.each(CASES)(
	"$name discovery coalescing",
	({ builtinId, customId, registerBoth, credentials, payload, listUrlFragment }) => {
		it("issues one base-list request for two entries on the same backend and stamps each id", async () => {
			const listCalls: string[] = [];
			let release!: () => void;
			const gate = new Promise<void>((resolve) => (release = resolve));
			const fetchMock = vi.fn(async (input: string | URL | Request) => {
				const url = urlOf(input);
				if (url.includes(listUrlFragment)) {
					listCalls.push(url);
					// Hold the flight open until both providers have had the
					// chance to join, then let it complete.
					queueMicrotask(() => release());
					await gate;
					return Response.json(payload);
				}
				// Enrichment or other follow-up requests (e.g. Ollama /api/show)
				// are per-provider and not coalesced.
				return Response.json({});
			});
			vi.stubGlobal("fetch", fetchMock);

			const registry = new ProviderRegistry(logger);
			registerBoth(registry, customId);

			const [builtinModels, customModels] = await Promise.all([
				registry.getModelsForProvider(builtinId, credentials),
				registry.getModelsForProvider(customId, credentials),
			]);

			expect(listCalls).toHaveLength(1);
			expect(builtinModels.length).toBeGreaterThanOrEqual(1);
			expect(customModels.length).toBeGreaterThanOrEqual(1);
			expect(builtinModels[0].providerId).toBe(builtinId);
			expect(customModels[0].providerId).toBe(customId);
		});
	},
);

describe("gemini URL-carried credential identity", () => {
	function registerGeminiPair(registry: ProviderRegistry): void {
		registerGeminiProvider(registry, logger);
		registerCustomGeminiProvider(registry, mintCustomProviderId("dup-gemini"), logger);
	}

	it("does not share a flight when the same backend is configured with different API keys", async () => {
		const listCalls: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = urlOf(input);
			if (url.includes("/models")) {
				listCalls.push(url);
			}
			return Response.json({ models: [] });
		});
		vi.stubGlobal("fetch", fetchMock);

		const registry = new ProviderRegistry(logger);
		registerGeminiPair(registry);

		await Promise.all([
			registry.getModelsForProvider("gemini", { type: "apikey", apiKey: "gem-key-a" }),
			registry.getModelsForProvider("dup-gemini", { type: "apikey", apiKey: "gem-key-b" }),
		]);

		expect(listCalls).toHaveLength(2);
	});
});

describe("cached-model-fetcher coalescing identity hooks", () => {
	it("strips the URL-carried secret from the retained identity and folds it into the fingerprint", async () => {
		const identities: ModelRequestIdentity[] = [];
		const capturingCoalescer = {
			coalesceModelRequest: (
				_providerId: string,
				identity: ModelRequestIdentity,
				_caller: AbortSignal,
				execute: (signal: AbortSignal) => Promise<unknown>,
			) => {
				identities.push(identity);
				return execute(_caller);
			},
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ data: [] })),
		);

		const fetcher = createCachedModelFetcher<{ type: "apikey"; apiKey: string }>({
			providerId: "test-provider",
			resolveUrl: (credentials) => `http://dup:8000/models?key=${credentials.apiKey}`,
			hasCredentials: () => true,
			createHeaders: () => ({}),
			requestCoalescer: capturingCoalescer,
			identityUrl: (apiUrl) => {
				const url = new URL(apiUrl);
				url.searchParams.delete("key");
				return url.toString();
			},
			identityHeaders: (credentials) => ({ "x-identity-api-key": credentials.apiKey }),
			parseResponse: () => [] satisfies ModelInfo[],
			fallbackModels: [],
			logger,
		});

		await fetcher({ type: "apikey", apiKey: "sk-secret" });

		expect(identities).toHaveLength(1);
		expect(identities[0].url).not.toContain("sk-secret");
		expect(identities[0].headersFingerprint).toBe(
			fingerprintHeaders({ "x-identity-api-key": "sk-secret" }),
		);
		expect(identities[0].headersFingerprint).not.toBe(fingerprintHeaders({}));
	});
});
