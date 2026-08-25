/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	// Mutable so a test can simulate a refreshed token between requests.
	currentToken: { value: "entra-token-1" },
	createAzureEntraTokenProvider: vi.fn(),
}));

vi.mock("../../model-clients/azure-entra-token", () => ({
	createAzureEntraTokenProvider: mocks.createAzureEntraTokenProvider,
}));

import type { CancellationToken, Logger } from "../../types";
import { registerFoundryProvider } from "../foundry-provider";
import { ProviderRegistry } from "../ProviderRegistry";

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

const ENTRA_CREDENTIALS = {
	type: "azure-entra",
	baseUrl: "https://my-resource.openai.azure.com/openai/v1",
	scope: "https://cognitiveservices.azure.com/.default",
	tenantId: "my-tenant",
	customHeaders: { "x-team": "data-science" },
} as const;

function createRegistry() {
	const registry = new ProviderRegistry(logger);
	registerFoundryProvider(registry, logger);
	return registry;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	mocks.currentToken.value = "entra-token-1";
	mocks.createAzureEntraTokenProvider.mockImplementation(
		() => async () => mocks.currentToken.value,
	);
});

describe("Foundry model fetcher", () => {
	it("returns the static model-router entry for entra credentials with a baseUrl", async () => {
		const registry = createRegistry();
		const models = await registry.getModelsForProvider("ms-foundry", { ...ENTRA_CREDENTIALS });
		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({ id: "model-router", providerId: "ms-foundry" });
	});

	it("returns empty for entra credentials without a baseUrl", async () => {
		const registry = createRegistry();
		const models = await registry.getModelsForProvider("ms-foundry", {
			type: "azure-entra",
			baseUrl: "",
			scope: "https://cognitiveservices.azure.com/.default",
		});
		expect(models).toEqual([]);
	});

	it("returns empty for an unrelated credential type", async () => {
		const registry = createRegistry();
		const models = await registry.getModelsForProvider("ms-foundry", {
			type: "local",
			endpoint: "http://localhost:1234",
		});
		expect(models).toEqual([]);
	});
});

describe("Foundry client factory", () => {
	it("rejects a mismatched credential type", () => {
		const registry = createRegistry();
		expect(() =>
			registry.getClientForProvider("ms-foundry", {
				type: "local",
				endpoint: "http://localhost:1234",
			}),
		).toThrow(/requires API key credentials/);
	});

	it("creates the entra token provider from the credential scope and tenant", () => {
		const registry = createRegistry();
		const client = registry.getClientForProvider("ms-foundry", { ...ENTRA_CREDENTIALS });
		expect(client).not.toBeNull();
		expect(mocks.createAzureEntraTokenProvider).toHaveBeenCalledWith(
			"https://cognitiveservices.azure.com/.default",
			"my-tenant",
		);
	});
});

describe("Foundry entra wire requests", () => {
	async function captureChatRequest(): Promise<{
		headers: Headers;
		body: Record<string, unknown>;
	}> {
		let captured: { headers: Headers; body: Record<string, unknown> } | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: unknown, init?: RequestInit) => {
				captured = {
					headers: new Headers(init?.headers),
					body: JSON.parse(String(init?.body)),
				};
				return new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}),
		);

		const registry = createRegistry();
		const client = registry.getClientForProvider("ms-foundry", { ...ENTRA_CREDENTIALS });
		if (!client) throw new Error("no client");

		try {
			const stream = await client.chat({
				model: "model-router",
				messages: [{ role: "user", content: "hi" }],
				thinkingEffort: "high",
				allowSystemInMessages: true,
				cancellationToken,
			});
			for await (const part of stream) {
				void part;
			}
		} catch {
			// The request is captured before the intentionally minimal stream ends.
		}

		if (!captured) throw new Error("request was not captured");
		return captured;
	}

	it("injects the Entra bearer token and preserves customHeaders and request normalization", async () => {
		const { headers, body } = await captureChatRequest();

		// Bearer token from the (mocked) token provider wins over the SDK's
		// placeholder apiKey Authorization header.
		expect(headers.get("authorization")).toBe("Bearer entra-token-1");
		// customHeaders survive the composed fetch.
		expect(headers.get("x-team")).toBe("data-science");
		// The OpenAI-compatible request normalization still applies.
		expect(body.model).toBe("model-router");
	});

	it("acquires the token per request, so a refreshed token reaches the wire", async () => {
		await captureChatRequest();
		mocks.currentToken.value = "entra-token-2";
		const second = await captureChatRequest();
		expect(second.headers.get("authorization")).toBe("Bearer entra-token-2");
	});
});
