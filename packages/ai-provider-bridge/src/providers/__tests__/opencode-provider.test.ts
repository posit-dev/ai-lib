/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Built-in OpenCode provider (Go/Zen) behavioral contracts.
 *
 * Distinct from the custom-provider wire matrix in
 * `model-clients/__tests__/opencode-session-wire.test.ts` (which owns URL
 * matching and header-merge precedence): these pin the built-in
 * registrations — the product default URLs, the resolved-`baseUrl` override
 * reaching discovery AND chat, the constructor-default Chat Completions
 * route, and the host User-Agent arriving at both seams.
 */

import type { ModelMessage } from "ai";
import { OPENCODE_GO_BASE_URL, OPENCODE_ZEN_BASE_URL } from "ai-config";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRawFetchCapture } from "../../../tests/helpers/raw-fetch-capture";
import { registerAllProviders } from "../../register-all-providers";
import type { ApiKeyCredentials, CancellationToken, Logger, ModelClient } from "../../types";
import { registerOpencodeProvider, type OpencodeProviderId } from "../opencode-provider";
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

const HOST_USER_AGENT = "PositAssistant-Test/1.2.3+abc1234 (darwin)";

const MESSAGES: ModelMessage[] = [{ role: "user", content: "Hello" }];

afterEach(() => {
	vi.unstubAllGlobals();
});

function sseResponse(): Response {
	return new Response("data: [DONE]\n\n", {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function modelsResponse(ids: string[]): Response {
	return new Response(
		JSON.stringify({
			object: "list",
			data: ids.map((id) => ({ id, object: "model", owned_by: "opencode" })),
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function opencodeRegistry(userAgent?: string): ProviderRegistry {
	const registry = new ProviderRegistry(logger);
	registerOpencodeProvider(registry, "opencode-go", logger, userAgent);
	registerOpencodeProvider(registry, "opencode-zen", logger, userAgent);
	return registry;
}

async function driveChat(
	client: ModelClient,
	metadata?: { sessionId?: string; rootConversationId?: string },
): Promise<void> {
	try {
		const stream = await client.chat({
			model: "some-unknown-model",
			messages: MESSAGES,
			cancellationToken,
			metadata,
		});
		for await (const _part of stream) {
			// Drain the minimal mocked event stream.
		}
	} catch {
		// The wire request is captured before the intentionally incomplete
		// stream ends.
	}
}

function capturedHeaders(call: Parameters<typeof fetch>): Headers {
	return new Headers(call[1]?.headers);
}

describe("OpenCode built-in model discovery", () => {
	it("fetches each product's default /models URL with bearer auth and the host User-Agent", async () => {
		const capture = createRawFetchCapture(async () => modelsResponse(["kimi-k2.5"]));
		vi.stubGlobal("fetch", capture.mock);

		const registry = opencodeRegistry(HOST_USER_AGENT);
		const products: [OpencodeProviderId, string][] = [
			["opencode-go", OPENCODE_GO_BASE_URL],
			["opencode-zen", OPENCODE_ZEN_BASE_URL],
		];
		for (const [id, baseUrl] of products) {
			const models = await registry.getModelsForProvider(id, {
				type: "apikey",
				apiKey: "sk-test",
			});
			expect(models.map((model) => model.id)).toEqual(["kimi-k2.5"]);
			expect(models[0]?.providerId).toBe(id);
		}

		expect(capture.calls.map((call) => call[0])).toEqual(
			products.map(([, baseUrl]) => `${baseUrl}/models`),
		);
		for (const call of capture.calls) {
			const headers = capturedHeaders(call);
			expect(headers.get("authorization")).toBe("Bearer sk-test");
			expect(headers.get("user-agent")).toBe(HOST_USER_AGENT);
			// Discovery belongs to no conversation.
			expect(headers.get("x-opencode-session")).toBeNull();
		}
	});

	it("sends a configured baseUrl override to discovery instead of the default", async () => {
		const capture = createRawFetchCapture(async () => modelsResponse(["m1"]));
		vi.stubGlobal("fetch", capture.mock);

		const registry = opencodeRegistry();
		await registry.getModelsForProvider("opencode-zen", {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: "https://gateway.example.com/v1/",
		});

		expect(capture.single()[0]).toBe("https://gateway.example.com/v1/models");
	});

	it("returns no models without an API key", async () => {
		const capture = createRawFetchCapture(async () => modelsResponse(["m1"]));
		vi.stubGlobal("fetch", capture.mock);

		const registry = opencodeRegistry();
		const models = await registry.getModelsForProvider("opencode-go", {
			type: "apikey",
			apiKey: "",
		});

		expect(models).toEqual([]);
		expect(capture.calls).toHaveLength(0);
	});
});

describe("OpenCode built-in chat", () => {
	function registeredClient(
		credentials: ApiKeyCredentials,
		providerId: OpencodeProviderId = "opencode-zen",
	): ModelClient {
		// The ordinary no-config host path: everything comes through
		// registerAllProviders, and the client resolves via the provider-id
		// factory ahead of the catalog's `openai` client kind.
		const registry = new ProviderRegistry(logger);
		registerAllProviders(registry, logger, {
			positAiBaseUrl: "https://api.posit.cloud",
			providerUserAgent: HOST_USER_AGENT,
		});
		const client = registry.getClientForProviderOrKind(providerId, credentials, "openai");
		if (!client) {
			throw new Error("registry returned no client");
		}
		return client;
	}

	it("takes the constructor-default completions route and carries the session headers", async () => {
		const capture = createRawFetchCapture(async () => sseResponse());
		vi.stubGlobal("fetch", capture.mock);

		// No configured baseUrl: the product default applies. An unknown model
		// (no protocol stamp) must use the client's constructor apiMode —
		// completions, per the 2026-09-09 probe (`/responses` 500s).
		const client = registeredClient({ type: "apikey", apiKey: "sk-test" });
		await driveChat(client, { rootConversationId: "root-1" });

		const [url, init] = capture.single();
		expect(url).toBe(`${OPENCODE_ZEN_BASE_URL}/chat/completions`);
		const headers = new Headers(init?.headers);
		expect(headers.get("x-opencode-session")).toBe("root-1");
		expect(headers.get("user-agent")?.startsWith(HOST_USER_AGENT)).toBe(true);
		expect(headers.get("authorization")).toBe("Bearer sk-test");
	});

	it("sends a configured baseUrl override to chat and turns the session header off", async () => {
		const capture = createRawFetchCapture(async () => sseResponse());
		vi.stubGlobal("fetch", capture.mock);

		const client = registeredClient(
			{
				type: "apikey",
				apiKey: "sk-test",
				baseUrl: "https://gateway.example.com/v1",
			},
			"opencode-go",
		);
		await driveChat(client, { rootConversationId: "root-1" });

		const [url, init] = capture.single();
		expect(url).toBe("https://gateway.example.com/v1/chat/completions");
		// Destination-based policy: routing away from opencode.ai drops the
		// generated session header.
		expect(new Headers(init?.headers).get("x-opencode-session")).toBeNull();
	});

	it("honors a per-request protocol stamp over the constructor default", async () => {
		const capture = createRawFetchCapture(async () => sseResponse());
		vi.stubGlobal("fetch", capture.mock);

		// No discovered model carries a stamp today (none probe-verified for
		// Responses), so the override arrives as an explicit param — the same
		// seam a future stamped ModelInfo.protocol flows through.
		const client = registeredClient({ type: "apikey", apiKey: "sk-test" }, "opencode-go");
		try {
			const stream = await client.chat({
				model: "some-unknown-model",
				messages: MESSAGES,
				cancellationToken,
				protocol: "openai-responses",
			});
			for await (const _part of stream) {
				// Drain.
			}
		} catch {
			// The wire request is captured before the stream ends.
		}

		expect(capture.single()[0]).toBe(`${OPENCODE_GO_BASE_URL}/responses`);
	});

	it("rejects non-apikey credentials", () => {
		const registry = opencodeRegistry();
		expect(() =>
			registry.getClientForProvider("opencode-go", { type: "oauth", accessToken: "t" }),
		).toThrow("requires API key credentials");
	});
});
