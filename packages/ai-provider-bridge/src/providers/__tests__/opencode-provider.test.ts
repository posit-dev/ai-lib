/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Built-in OpenCode provider behavioral contracts.
 *
 * Distinct from the custom-provider wire matrix in
 * `model-clients/__tests__/opencode-session-wire.test.ts` (which owns URL
 * matching and header-merge precedence): these pin the built-in
 * registration — the default (Go) URL, the resolved-`baseUrl` override
 * reaching discovery AND chat, the base-URL-partitioned discovery cache
 * (the product-switch regression), the constructor-default Chat Completions
 * route, and the host User-Agent arriving at both seams.
 */

import type { ModelMessage } from "ai";
import { OPENCODE_GO_BASE_URL, OPENCODE_ZEN_BASE_URL } from "ai-config";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRawFetchCapture } from "../../../tests/helpers/raw-fetch-capture";
import { registerAllProviders } from "../../register-all-providers";
import type { ApiKeyCredentials, CancellationToken, Logger, ModelClient } from "../../types";
import { normalizeProtocol } from "../../types";
import { registerOpencodeProvider } from "../opencode-provider";
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
	registerOpencodeProvider(registry, logger, userAgent);
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
	it("fetches the default (Go) /models URL with bearer auth and the host User-Agent", async () => {
		const capture = createRawFetchCapture(async () => modelsResponse(["kimi-k2.5"]));
		vi.stubGlobal("fetch", capture.mock);

		const registry = opencodeRegistry(HOST_USER_AGENT);
		const models = await registry.getModelsForProvider("opencode", {
			type: "apikey",
			apiKey: "sk-test",
		});

		expect(models.map((model) => model.id)).toEqual(["kimi-k2.5"]);
		expect(models[0]?.providerId).toBe("opencode");
		expect(capture.calls.map((call) => call[0])).toEqual([`${OPENCODE_GO_BASE_URL}/models`]);
		const headers = capturedHeaders(capture.calls[0]!);
		expect(headers.get("authorization")).toBe("Bearer sk-test");
		expect(headers.get("user-agent")).toBe(HOST_USER_AGENT);
		// Discovery belongs to no conversation.
		expect(headers.get("x-opencode-session")).toBeNull();
	});

	it("sends a configured baseUrl override to discovery instead of the default", async () => {
		const capture = createRawFetchCapture(async () => modelsResponse(["m1"]));
		vi.stubGlobal("fetch", capture.mock);

		const registry = opencodeRegistry();
		await registry.getModelsForProvider("opencode", {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: "https://gateway.example.com/v1/",
		});

		expect(capture.single()[0]).toBe("https://gateway.example.com/v1/models");
	});

	it("refetches on a product switch instead of serving the stale cached catalog", async () => {
		// Regression: one provider ID serves two endpoints; the discovery cache
		// must partition on the resolved baseUrl or a Go switch would serve the
		// Zen catalog (and vice versa) for up to the cache TTL.
		const capture = createRawFetchCapture(async (input) => {
			const url = String(input);
			return modelsResponse(url.includes("/zen/go/") ? ["go-model"] : ["zen-model"]);
		});
		vi.stubGlobal("fetch", capture.mock);

		const registry = opencodeRegistry();
		const zen = await registry.getModelsForProvider("opencode", {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: OPENCODE_ZEN_BASE_URL,
		});
		expect(zen.map((model) => model.id)).toEqual(["zen-model"]);

		// Same provider ID, changed resolved baseUrl (a product switch).
		const go = await registry.getModelsForProvider("opencode", {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: OPENCODE_GO_BASE_URL,
		});
		expect(go.map((model) => model.id)).toEqual(["go-model"]);

		// Each endpoint was fetched exactly once...
		expect(capture.calls.map((call) => call[0])).toEqual([
			`${OPENCODE_ZEN_BASE_URL}/models`,
			`${OPENCODE_GO_BASE_URL}/models`,
		]);

		// ...and switching back is served from its own cache entry.
		const zenAgain = await registry.getModelsForProvider("opencode", {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: OPENCODE_ZEN_BASE_URL,
		});
		expect(zenAgain.map((model) => model.id)).toEqual(["zen-model"]);
		expect(capture.calls).toHaveLength(2);
	});

	it("returns no models without an API key", async () => {
		const capture = createRawFetchCapture(async () => modelsResponse(["m1"]));
		vi.stubGlobal("fetch", capture.mock);

		const registry = opencodeRegistry();
		const models = await registry.getModelsForProvider("opencode", {
			type: "apikey",
			apiKey: "",
		});

		expect(models).toEqual([]);
		expect(capture.calls).toHaveLength(0);
	});
});

describe("OpenCode built-in chat", () => {
	function registeredClient(credentials: ApiKeyCredentials): ModelClient {
		// The ordinary no-config host path: everything comes through
		// registerAllProviders, and the client resolves via the provider-id
		// factory ahead of the catalog's `openai` client kind.
		const registry = new ProviderRegistry(logger);
		registerAllProviders(registry, logger, {
			positAiBaseUrl: "https://api.posit.cloud",
			providerUserAgent: HOST_USER_AGENT,
		});
		const client = registry.getClientForProviderOrKind("opencode", credentials, "openai");
		if (!client) {
			throw new Error("registry returned no client");
		}
		return client;
	}

	it("takes the constructor-default completions route and carries the session headers", async () => {
		const capture = createRawFetchCapture(async () => sseResponse());
		vi.stubGlobal("fetch", capture.mock);

		// No configured baseUrl: the default (Go) endpoint applies. An unknown model
		// (no protocol stamp) must use the client's constructor apiMode —
		// completions, per the 2026-09-09 probe (`/responses` 500s).
		const client = registeredClient({ type: "apikey", apiKey: "sk-test" });
		await driveChat(client, { rootConversationId: "root-1" });

		const [url, init] = capture.single();
		expect(url).toBe(`${OPENCODE_GO_BASE_URL}/chat/completions`);
		const headers = new Headers(init?.headers);
		expect(headers.get("x-opencode-session")).toBe("root-1");
		expect(headers.get("user-agent")?.startsWith(HOST_USER_AGENT)).toBe(true);
		expect(headers.get("authorization")).toBe("Bearer sk-test");
	});

	it("sends a configured baseUrl override to chat and turns the session header off", async () => {
		const capture = createRawFetchCapture(async () => sseResponse());
		vi.stubGlobal("fetch", capture.mock);

		const client = registeredClient({
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: "https://gateway.example.com/v1",
		});
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
		const client = registeredClient({ type: "apikey", apiKey: "sk-test" });
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

	it("routes discovered gpt-5.6-luna to /responses with a Responses-shaped body (Luna regression)", async () => {
		// Regression (2026-09-11 UTC capture): gpt-5.6-luna was sent to
		// `/chat/completions` and answered a generic HTTP 500; OpenCode documents
		// it on `/responses`. Discovery stamps the documented protocol and the
		// host flow carries the stamp into chat params, so a registry-created
		// provider must reach `/responses` with a Responses-shaped body.
		const capture = createRawFetchCapture(async (input) => {
			const url = String(input);
			if (url.endsWith("/models")) {
				return modelsResponse(["gpt-5.6-luna"]);
			}
			return sseResponse();
		});
		vi.stubGlobal("fetch", capture.mock);

		const registry = new ProviderRegistry(logger);
		registerAllProviders(registry, logger, {
			positAiBaseUrl: "https://api.posit.cloud",
			providerUserAgent: HOST_USER_AGENT,
		});
		const credentials: ApiKeyCredentials = { type: "apikey", apiKey: "sk-test" };
		const discovered = await registry.getModelsForProvider("opencode", credentials);
		const luna = discovered.find((model) => model.id === "gpt-5.6-luna");
		if (!luna) {
			throw new Error("discovery did not return gpt-5.6-luna");
		}

		const client = registry.getClientForProviderOrKind("opencode", credentials, "openai");
		if (!client) {
			throw new Error("registry returned no client");
		}
		try {
			const stream = await client.chat({
				model: luna.id,
				messages: MESSAGES,
				cancellationToken,
				...(luna.protocol !== undefined ? { protocol: normalizeProtocol(luna.protocol) } : {}),
			});
			for await (const _part of stream) {
				// Drain the minimal mocked event stream.
			}
		} catch {
			// The wire request is captured before the stream ends.
		}

		const chatCall = capture.calls.find((call) => !String(call[0]).endsWith("/models"));
		if (!chatCall) {
			throw new Error("no chat request captured");
		}
		expect(chatCall[0]).toBe(`${OPENCODE_GO_BASE_URL}/responses`);
		const body = JSON.parse(String(chatCall[1]?.body)) as Record<string, unknown>;
		expect(body).toHaveProperty("input");
		expect(body).not.toHaveProperty("messages");
	});

	it("rejects non-apikey credentials", () => {
		const registry = opencodeRegistry();
		expect(() =>
			registry.getClientForProvider("opencode", { type: "oauth", accessToken: "t" }),
		).toThrow("requires API key credentials");
	});
});

describe("OpenCode protocol routing", () => {
	function registeredClient(credentials: ApiKeyCredentials): ModelClient {
		const registry = new ProviderRegistry(logger);
		registerAllProviders(registry, logger, {
			positAiBaseUrl: "https://api.posit.cloud",
			providerUserAgent: HOST_USER_AGENT,
		});
		const client = registry.getClientForProviderOrKind("opencode", credentials, "openai");
		if (!client) {
			throw new Error("registry returned no client");
		}
		return client;
	}

	async function driveModel(
		client: ModelClient,
		model: string,
		extra?: { protocol?: Parameters<ModelClient["chat"]>[0]["protocol"]; baseUrl?: string },
	): Promise<void> {
		try {
			const stream = await client.chat({
				model,
				messages: MESSAGES,
				cancellationToken,
				metadata: { rootConversationId: "root-1" },
				...extra,
			});
			for await (const _part of stream) {
				// Drain the minimal mocked event stream.
			}
		} catch {
			// The wire request is captured before the stream ends.
		}
	}

	it("stamps discovered models per product, including the MiniMax split", async () => {
		const capture = createRawFetchCapture(async (input) => {
			const url = String(input);
			return modelsResponse(
				url.includes("/zen/go/") ? ["minimax-m3"] : ["minimax-m3", "gemini-3.8-flash"],
			);
		});
		vi.stubGlobal("fetch", capture.mock);

		const registry = opencodeRegistry();
		const go = await registry.getModelsForProvider("opencode", {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: OPENCODE_GO_BASE_URL,
		});
		expect(go.find((m) => m.id === "minimax-m3")?.protocol).toBe("anthropic-messages");

		const zen = await registry.getModelsForProvider("opencode", {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: OPENCODE_ZEN_BASE_URL,
		});
		expect(zen.find((m) => m.id === "minimax-m3")?.protocol).toBe("openai-chat");
		expect(zen.find((m) => m.id === "gemini-3.8-flash")?.protocol).toBe("google-generative");
	});

	it("excludes a Gemini model with no verified generateContent profile, with a diagnostic", async () => {
		const capture = createRawFetchCapture(async () =>
			modelsResponse(["gemini-9.9-flash", "kimi-k2.5"]),
		);
		vi.stubGlobal("fetch", capture.mock);
		const warn = vi.fn();
		const capturingLogger: Logger = { ...logger, warn };

		const registry = new ProviderRegistry(capturingLogger);
		registerOpencodeProvider(registry, capturingLogger);
		const models = await registry.getModelsForProvider("opencode", {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: OPENCODE_ZEN_BASE_URL,
		});

		expect(models.map((m) => m.id)).toEqual(["kimi-k2.5"]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("gemini-9.9-flash"));
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("generateContent"));
	});

	it("routes a direct MiniMax call on Go to /messages without prior discovery", async () => {
		const capture = createRawFetchCapture(async () => sseResponse());
		vi.stubGlobal("fetch", capture.mock);

		const client = registeredClient({
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: OPENCODE_GO_BASE_URL,
		});
		await driveModel(client, "minimax-m3");

		const [url, init] = capture.single();
		expect(url).toBe(`${OPENCODE_GO_BASE_URL}/messages`);
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		expect(body).toHaveProperty("messages");
		const headers = new Headers(init?.headers);
		// The Messages route reads the Anthropic-native key header, not Bearer
		// (probe-verified 2026-09-11 on both products).
		expect(headers.get("x-api-key")).toBe("sk-test");
		expect(headers.get("authorization")).toBeNull();
		expect(headers.get("x-opencode-session")).toBe("root-1");
		expect(headers.get("user-agent")?.startsWith(HOST_USER_AGENT)).toBe(true);
	});

	it("routes a direct Claude call on Zen to /messages with a Messages-shaped body", async () => {
		const capture = createRawFetchCapture(async () => sseResponse());
		vi.stubGlobal("fetch", capture.mock);

		const client = registeredClient({
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: OPENCODE_ZEN_BASE_URL,
		});
		await driveModel(client, "claude-opus-5");

		const [url, init] = capture.single();
		expect(url).toBe(`${OPENCODE_ZEN_BASE_URL}/messages`);
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		expect(body).toHaveProperty("messages");
		expect(body).toHaveProperty("max_tokens");
		expect(body).not.toHaveProperty("input");
	});

	it("routes a direct Gemini call on Zen to generateContent with the session policy", async () => {
		const capture = createRawFetchCapture(async () => sseResponse());
		vi.stubGlobal("fetch", capture.mock);

		const client = registeredClient({
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: OPENCODE_ZEN_BASE_URL,
		});
		await driveModel(client, "gemini-3.8-flash");

		const [url, init] = capture.single();
		expect(String(url)).toContain(
			`${OPENCODE_ZEN_BASE_URL}/models/gemini-3.8-flash:streamGenerateContent`,
		);
		// generateContent-shaped body, not Chat Completions.
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		expect(body).toHaveProperty("contents");
		expect(body).not.toHaveProperty("messages");
		const headers = new Headers(init?.headers);
		// The generateContent route reads the Google-native key header
		// (probe-verified 2026-09-11).
		expect(headers.get("x-goog-api-key")).toBe("sk-test");
		expect(headers.get("authorization")).toBeNull();
		expect(headers.get("x-opencode-session")).toBe("root-1");
		expect(headers.get("user-agent")?.startsWith(HOST_USER_AGENT)).toBe(true);
	});

	it("never lets a custom x-goog-api-key header override the OpenCode credential", async () => {
		const capture = createRawFetchCapture(async () => sseResponse());
		vi.stubGlobal("fetch", capture.mock);

		const client = registeredClient({
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: OPENCODE_ZEN_BASE_URL,
			customHeaders: { "x-goog-api-key": "unrelated-google-key" },
		});
		await driveModel(client, "gemini-3.8-flash");

		expect(String(capture.single()[0])).toContain(":streamGenerateContent");
		const headers = new Headers(capture.single()[1]?.headers);
		expect(headers.get("x-goog-api-key")).toBe("sk-test");
	});

	it("changes MiniMax's wire route across a product switch under one provider ID", async () => {
		const capture = createRawFetchCapture(async () => sseResponse());
		vi.stubGlobal("fetch", capture.mock);

		const goClient = registeredClient({
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: OPENCODE_GO_BASE_URL,
		});
		await driveModel(goClient, "minimax-m3");

		const zenClient = registeredClient({
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: OPENCODE_ZEN_BASE_URL,
		});
		await driveModel(zenClient, "minimax-m3");

		expect(capture.calls.map((call) => call[0])).toEqual([
			`${OPENCODE_GO_BASE_URL}/messages`,
			`${OPENCODE_ZEN_BASE_URL}/chat/completions`,
		]);
	});

	it("honors an explicit per-request baseUrl over the credential root", async () => {
		const capture = createRawFetchCapture(async () => sseResponse());
		vi.stubGlobal("fetch", capture.mock);

		// Credentials say Go; the request's resolved baseUrl points at Zen —
		// inference follows the effective destination, so MiniMax takes Zen's
		// Chat Completions route.
		const client = registeredClient({
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: OPENCODE_GO_BASE_URL,
		});
		await driveModel(client, "minimax-m3", { baseUrl: OPENCODE_ZEN_BASE_URL });

		expect(capture.single()[0]).toBe(`${OPENCODE_ZEN_BASE_URL}/chat/completions`);
	});

	it("rejects an unsupported explicit protocol without sending a request", async () => {
		const capture = createRawFetchCapture(async () => sseResponse());
		vi.stubGlobal("fetch", capture.mock);

		const client = registeredClient({ type: "apikey", apiKey: "sk-test" });
		await expect(
			client.chat({
				model: "some-model",
				messages: MESSAGES,
				cancellationToken,
				protocol: "bedrock-converse",
			}),
		).rejects.toThrow('OpenCode provider cannot route model "some-model" over protocol');
		expect(capture.calls).toHaveLength(0);
	});
});
