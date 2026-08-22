/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mintCustomProviderId } from "ai-config";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiKeyCredentials, Logger } from "../../types";
import { registerCustomOpenAICompatibleProvider } from "../openai-compatible-provider";
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
	vi.clearAllMocks();
});

describe("registerCustomOpenAICompatibleProvider", () => {
	it("discovers /models and stamps the custom provider id", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({ data: [{ id: "gateway-model", object: "model" }] }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const registry = new ProviderRegistry(logger);
		registerCustomOpenAICompatibleProvider(registry, mintCustomProviderId("acme-openai"), logger);

		const models = await registry.getModelsForProvider("acme-openai", {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: "https://gateway.example/v1/",
		});

		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({ id: "gateway-model", providerId: "acme-openai" });
		expect(fetchMock).toHaveBeenCalledWith("https://gateway.example/v1/models", {
			headers: { Authorization: "Bearer sk-test" },
			// The cached fetcher's discovery-deadline abort signal rides the request.
			signal: expect.any(AbortSignal),
		});
	});

	it("keeps independent model caches per custom endpoint", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const id = url.includes("gateway-a") ? "model-a" : "model-b";
			return Response.json({ data: [{ id }] });
		});
		vi.stubGlobal("fetch", fetchMock);

		const registry = new ProviderRegistry(logger);
		registerCustomOpenAICompatibleProvider(registry, mintCustomProviderId("acme-a"), logger);
		registerCustomOpenAICompatibleProvider(registry, mintCustomProviderId("acme-b"), logger);

		const credsA = {
			type: "apikey",
			apiKey: "",
			baseUrl: "https://gateway-a/v1",
		} satisfies ApiKeyCredentials;
		const credsB = {
			type: "apikey",
			apiKey: "",
			baseUrl: "https://gateway-b/v1",
		} satisfies ApiKeyCredentials;
		for (let i = 0; i < 2; i++) {
			expect((await registry.getModelsForProvider("acme-a", credsA))[0]?.id).toBe("model-a");
			expect((await registry.getModelsForProvider("acme-b", credsB))[0]?.id).toBe("model-b");
		}

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("registers the kind-keyed client factory without the built-in registrar", () => {
		const registry = new ProviderRegistry(logger);
		registerCustomOpenAICompatibleProvider(registry, mintCustomProviderId("acme-openai"), logger);

		expect(
			registry.getClientForProviderOrKind(
				"acme-openai",
				{ type: "apikey", apiKey: "", baseUrl: "https://gateway.example/v1" },
				"openai-compatible",
			),
		).not.toBeNull();
	});

	it("does not pin the custom id when the catalog kind changes", () => {
		const registry = new ProviderRegistry(logger);
		registerCustomOpenAICompatibleProvider(registry, mintCustomProviderId("acme-openai"), logger);

		const litellmClient = { chat: vi.fn() };
		registry.registerClientFactory("litellm", () => litellmClient);

		expect(
			registry.getClientForProviderOrKind(
				"acme-openai",
				{ type: "apikey", apiKey: "", baseUrl: "https://gateway.example/v1" },
				"litellm",
			),
		).toBe(litellmClient);
	});
});
