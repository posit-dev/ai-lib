/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from "vitest";

import { createRawFetchCapture } from "../../../tests/helpers/raw-fetch-capture";
import type { ModelClientChatParams } from "../../model-clients/ModelClient";
import type { ApiKeyCredentials, CancellationToken, Logger } from "../../types";
import { DEFAULT_DISCOVERY_DEADLINE_MS } from "../cached-model-fetcher";
import {
	registerCustomPortkeyProvider,
	registerPortkeyProvider,
	resolvePortkeyConnection,
} from "../portkey-provider";
import { ProviderRegistry } from "../ProviderRegistry";

const logger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

const HOSTED_CREDENTIALS: ApiKeyCredentials = {
	type: "apikey",
	apiKey: "pk-test",
	baseUrl: "https://api.portkey.ai/v1",
};

const OSS_CREDENTIALS: ApiKeyCredentials = {
	type: "apikey",
	apiKey: "sk-upstream",
	baseUrl: "http://localhost:8787",
};

// ---------------------------------------------------------------------------
// Connection resolution
// ---------------------------------------------------------------------------

describe("resolvePortkeyConnection — URL classification", () => {
	it.each([
		"https://api.portkey.ai",
		"https://api.portkey.ai/",
		"https://api.portkey.ai/v1",
		"https://api.portkey.ai/v1/",
	])("classifies the canonical HTTPS origin as hosted and normalizes to /v1 (%s)", (baseUrl) => {
		const connection = resolvePortkeyConnection({ type: "apikey", apiKey: "pk", baseUrl });
		expect(connection.mode).toBe("hosted");
		expect(connection.baseUrl).toBe("https://api.portkey.ai/v1");
	});

	it.each([
		"http://api.portkey.ai",
		"http://api.portkey.ai/",
		"http://api.portkey.ai/v1",
		"http://api.portkey.ai/v1/",
	])("rejects the canonical host over plain HTTP with a local error (%s)", (baseUrl) => {
		// No safe classification exists: hosted would put the Portkey key on
		// plaintext, OSS would drop it into upstream-native headers on plaintext.
		expect(() => resolvePortkeyConnection({ type: "apikey", apiKey: "pk", baseUrl })).toThrow(
			/api\.portkey\.ai/,
		);
	});

	it("rejects the canonical host on a non-default port", () => {
		expect(() =>
			resolvePortkeyConnection({
				type: "apikey",
				apiKey: "pk",
				baseUrl: "https://api.portkey.ai:8443",
			}),
		).toThrow(/api\.portkey\.ai/);
	});

	it("classifies lookalike hosts as OSS, never hosted", () => {
		const connection = resolvePortkeyConnection({
			type: "apikey",
			apiKey: "sk",
			baseUrl: "https://api.portkey.ai.example/v1",
		});
		expect(connection.mode).toBe("oss");
		expect(connection.baseUrl).toBe("https://api.portkey.ai.example/v1");
	});

	it("keeps plain HTTP valid for explicit self-hosted hosts", () => {
		const connection = resolvePortkeyConnection(OSS_CREDENTIALS);
		expect(connection.mode).toBe("oss");
		expect(connection.baseUrl).toBe("http://localhost:8787/v1");
	});

	it("throws the instructive error for missing or empty base URLs", () => {
		for (const baseUrl of [undefined, "", "   "]) {
			expect(() => resolvePortkeyConnection({ type: "apikey", apiKey: "pk", baseUrl })).toThrow(
				/PORTKEY_BASE_URL[\s\S]*configure form/,
			);
		}
	});

	it("throws on unparseable URLs", () => {
		expect(() =>
			resolvePortkeyConnection({ type: "apikey", apiKey: "pk", baseUrl: "not a url" }),
		).toThrow(/Invalid Portkey base URL/);
	});

	it.each(["", "   "])("rejects an empty hosted API key locally (%j)", (apiKey) => {
		expect(() =>
			resolvePortkeyConnection({
				type: "apikey",
				apiKey,
				baseUrl: "https://api.portkey.ai/v1",
			}),
		).toThrow(/hosted Portkey[\s\S]*non-empty API key/i);
	});

	it("accepts an empty API key for an OSS credential-injecting proxy", () => {
		const connection = resolvePortkeyConnection({
			type: "apikey",
			apiKey: "",
			baseUrl: "http://localhost:8787",
		});
		expect(connection.mode).toBe("oss");
	});
});

describe("resolvePortkeyConnection — header material", () => {
	it("filters secret Portkey headers case-insensitively; the stored key always wins", () => {
		const connection = resolvePortkeyConnection({
			...HOSTED_CREDENTIALS,
			customHeaders: {
				"X-Portkey-Api-Key": "attacker-key",
				"X-PORTKEY-VIRTUAL-KEY": "attacker-vk",
				"X-Tenant": "acme",
			},
		});
		expect(connection.mode).toBe("hosted");
		if (connection.mode !== "hosted") return;
		expect(connection.chatHeaders).toEqual({
			"X-Tenant": "acme",
			"x-portkey-api-key": "pk-test",
		});
		expect(connection.discoveryHeaders).toEqual({
			"X-Tenant": "acme",
			"x-portkey-api-key": "pk-test",
		});
	});

	it("passes routing headers through on chat but drops them from discovery, case-insensitively", () => {
		const connection = resolvePortkeyConnection({
			...HOSTED_CREDENTIALS,
			customHeaders: { "X-Portkey-Provider": "openai", "X-Portkey-Config": "cfg-123" },
		});
		expect(connection.mode).toBe("hosted");
		if (connection.mode !== "hosted") return;
		expect(connection.chatHeaders).toEqual({
			"X-Portkey-Provider": "openai",
			"X-Portkey-Config": "cfg-123",
			"x-portkey-api-key": "pk-test",
		});
		expect(connection.discoveryHeaders).toEqual({ "x-portkey-api-key": "pk-test" });
	});

	it("injects the OSS single-upstream default routing header when the user supplied none", () => {
		const connection = resolvePortkeyConnection(OSS_CREDENTIALS);
		expect(connection.mode).toBe("oss");
		if (connection.mode !== "oss") return;
		expect(connection.upstreamKey).toBe("sk-upstream");
		expect(connection.chatHeaders).toEqual({ "x-portkey-provider": "anthropic" });
	});

	it("lets a user-supplied routing header win over the OSS default, case-insensitively", () => {
		const withProvider = resolvePortkeyConnection({
			...OSS_CREDENTIALS,
			customHeaders: { "X-Portkey-Provider": "openai" },
		});
		if (withProvider.mode !== "oss") throw new Error("expected oss");
		expect(withProvider.chatHeaders).toEqual({ "X-Portkey-Provider": "openai" });

		const withConfig = resolvePortkeyConnection({
			...OSS_CREDENTIALS,
			customHeaders: { "X-Portkey-Config": "cfg-123" },
		});
		if (withConfig.mode !== "oss") throw new Error("expected oss");
		expect(withConfig.chatHeaders).toEqual({ "X-Portkey-Config": "cfg-123" });
	});

	it("filters secret headers on the OSS path too", () => {
		const connection = resolvePortkeyConnection({
			...OSS_CREDENTIALS,
			customHeaders: { "X-Portkey-Api-Key": "leak", "X-Tenant": "acme" },
		});
		if (connection.mode !== "oss") throw new Error("expected oss");
		expect(connection.chatHeaders).toEqual({
			"X-Tenant": "acme",
			"x-portkey-provider": "anthropic",
		});
	});
});

// ---------------------------------------------------------------------------
// Model fetcher
// ---------------------------------------------------------------------------

interface CapturedRequest {
	url: string;
	headers: Record<string, string> | Headers | undefined;
}

function stubFetchPages(pages: unknown[]): { requests: CapturedRequest[] } {
	const requests: CapturedRequest[] = [];
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		requests.push({ url, headers: init?.headers as Record<string, string> | undefined });
		const page = pages[Math.min(requests.length - 1, pages.length - 1)];
		return Response.json(page);
	});
	vi.stubGlobal("fetch", fetchMock);
	return { requests };
}

describe("portkey model fetcher", () => {
	it("registers a custom-id fetcher that stamps discovered hosted models", async () => {
		stubFetchPages([
			{
				data: [{ id: "@anthropic-prod/claude-haiku-4-5" }],
				total: 1,
			},
		]);
		const registry = new ProviderRegistry(logger);
		registerCustomPortkeyProvider(registry, "acme-portkey", logger);

		const models = await registry.getModelsForProvider("acme-portkey", HOSTED_CREDENTIALS);

		expect(models).toHaveLength(1);
		expect(models[0].providerId).toBe("acme-portkey");
		expect(models[0].maxOutputTokens).toBe(64_000);
	});

	it("registers the kind-keyed client factory without the built-in registrar", () => {
		const registry = new ProviderRegistry(logger);
		registerCustomPortkeyProvider(registry, "acme-portkey", logger);

		expect(
			registry.getClientForProviderOrKind(
				"acme-portkey",
				{ type: "apikey", apiKey: "", baseUrl: "http://localhost:8787" },
				"portkey",
			),
		).not.toBeNull();
	});

	it("returns no discovered models for a base-URL-only OSS custom entry without HTTP", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const registry = new ProviderRegistry(logger);
		registerCustomPortkeyProvider(registry, "acme-portkey", logger);

		const models = await registry.getModelsForProvider("acme-portkey", {
			type: "apikey",
			apiKey: "",
			baseUrl: "http://localhost:8787",
		});

		expect(models).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("logs and yields no models for a hosted custom entry with an empty key", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const registry = new ProviderRegistry(logger);
		registerCustomPortkeyProvider(registry, "acme-portkey", logger);

		const models = await registry.getModelsForProvider("acme-portkey", {
			type: "apikey",
			apiKey: "  ",
			baseUrl: "https://api.portkey.ai/v1",
		});

		expect(models).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("Hosted Portkey requires a non-empty API key"),
		);
	});

	it("passes the discovery-deadline abort signal to every catalog page request", async () => {
		const signals: (AbortSignal | undefined)[] = [];
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			signals.push(init?.signal ?? undefined);
			return Response.json({ data: [{ id: "@anthropic-prod/claude-haiku-4-5" }], total: 1 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const registry = new ProviderRegistry(logger);
		registerPortkeyProvider(registry, logger);
		const models = await registry.getModelsForProvider("portkey", HOSTED_CREDENTIALS);

		expect(models).toHaveLength(1);
		expect(signals).toHaveLength(1);
		expect(signals[0]).toBeInstanceOf(AbortSignal);
		expect(signals[0]!.aborted).toBe(false);
	});

	it("stops paginating when the discovery deadline expires mid-catalog", async () => {
		vi.useFakeTimers();
		const signals: (AbortSignal | undefined)[] = [];
		const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
			signals.push(init?.signal ?? undefined);
			if (signals.length === 1) {
				// Page 1 reports more models than received, so a second page follows.
				return Promise.resolve(
					Response.json({ data: [{ id: "@anthropic-prod/claude-haiku-4-5" }], total: 2 }),
				);
			}
			// Page 2 answers only when the request is cancelled — a late response
			// the fetcher must no longer accept.
			return new Promise<Response>((resolve) => {
				init?.signal?.addEventListener(
					"abort",
					() =>
						resolve(Response.json({ data: [{ id: "@anthropic-prod/claude-opus-4-6" }], total: 3 })),
					{ once: true },
				);
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const registry = new ProviderRegistry(logger);
		registerPortkeyProvider(registry, logger);
		const promise = registry.getModelsForProvider("portkey", HOSTED_CREDENTIALS);

		// Let page 1 complete and page 2 start (microtask-only work).
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchMock).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(DEFAULT_DISCOVERY_DEADLINE_MS);

		// The deadline fell back to no models, page 2's request was aborted, and
		// its late page did not trigger a third request.
		await expect(promise).resolves.toEqual([]);
		expect(signals[1]!.aborted).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("fetches the hosted catalog from the exact /v1/models URL (never /v1/v1) with the key header only", async () => {
		const { requests } = stubFetchPages([
			{
				data: [
					{ id: "@anthropic-prod/claude-haiku-4-5" },
					{ id: "@prod/sonnet-alias", canonical_slug: "claude-sonnet-5-20251101" },
					{ id: "@openai-prod/gpt-5-mini", provider: "openai" },
					{ id: "@google-prod/gemini-2.5-flash", provider: "google" },
				],
				total: 4,
			},
		]);

		const registry = new ProviderRegistry(logger);
		registerPortkeyProvider(registry, logger);
		const models = await registry.getModelsForProvider("portkey", HOSTED_CREDENTIALS);

		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe("https://api.portkey.ai/v1/models");
		expect(requests[0].headers).toEqual({ "x-portkey-api-key": "pk-test" });

		// Provisional policy: only the Claude family ships; OpenAI/Gemini catalog
		// entries are excluded pending the Phase 0 probes.
		expect(models.map((m) => m.id)).toEqual([
			"@anthropic-prod/claude-haiku-4-5",
			"@prod/sonnet-alias",
		]);
		for (const m of models) {
			expect(m.protocol).toBe("anthropic-messages");
			expect(m.vendor).toBe("anthropic");
			expect(m.providerId).toBe("portkey");
		}
		// Capabilities come from the underlying model id; the routed catalog id
		// is retained as the request model.
		expect(models[1].thinkingEffortLevels).toBeDefined();
		expect(models[0].maxOutputTokens).toBe(64_000);
	});

	it("drops routing headers from discovery but keeps other custom headers, mixed-case included", async () => {
		const { requests } = stubFetchPages([{ data: [], total: 0 }]);
		const registry = new ProviderRegistry(logger);
		registerPortkeyProvider(registry, logger);

		await registry.getModelsForProvider("portkey", {
			...HOSTED_CREDENTIALS,
			customHeaders: {
				"X-Portkey-Provider": "openai",
				"X-Portkey-Config": "cfg-123",
				"X-Portkey-Api-Key": "attacker-key",
				// SDK-managed headers must not reach discovery either — the
				// provider-owned fetch bypasses the cached fetcher's merge, so the
				// shared filter is applied inside resolvePortkeyConnection.
				Authorization: "Bearer sneaky",
				"X-Api-Key": "sneaky-native",
				"X-Tenant": "acme",
			},
		});

		expect(requests[0].headers).toEqual({
			"X-Tenant": "acme",
			"x-portkey-api-key": "pk-test",
		});
	});

	it("paginates with limit/offset until total is reached", async () => {
		const alias = (n: number) => ({
			id: `@prod/claude-alias-${n}`,
			canonical_slug: "claude-haiku-4-5",
		});
		const { requests } = stubFetchPages([
			{ data: [alias(1), alias(2)], total: 5 },
			{ data: [alias(3), alias(4)], total: 5 },
			{ data: [alias(5)], total: 5 },
		]);

		const registry = new ProviderRegistry(logger);
		registerPortkeyProvider(registry, logger);
		const models = await registry.getModelsForProvider("portkey", HOSTED_CREDENTIALS);

		expect(requests.map((r) => r.url)).toEqual([
			"https://api.portkey.ai/v1/models",
			"https://api.portkey.ai/v1/models?limit=2&offset=2",
			"https://api.portkey.ai/v1/models?limit=2&offset=4",
		]);
		expect(models).toHaveLength(5);
	});

	it("stops on an empty page even when total promises more (no-progress guard)", async () => {
		const { requests } = stubFetchPages([
			{ data: [{ id: "@prod/a", canonical_slug: "claude-haiku-4-5" }], total: 10 },
			{ data: [], total: 10 },
		]);

		const registry = new ProviderRegistry(logger);
		registerPortkeyProvider(registry, logger);
		const models = await registry.getModelsForProvider("portkey", HOSTED_CREDENTIALS);

		expect(requests).toHaveLength(2);
		expect(models).toHaveLength(1);
	});

	it("stops on a repeated non-empty page without duplicating models (no-progress guard)", async () => {
		// A server that ignores `offset` re-serves the same page; the guard must
		// detect no *new* ids, not just an empty page.
		const page = {
			data: [
				{ id: "@prod/claude-alias-1", canonical_slug: "claude-haiku-4-5" },
				{ id: "@prod/claude-alias-2", canonical_slug: "claude-haiku-4-5" },
			],
			total: 10,
		};
		const { requests } = stubFetchPages([page, page, page]);

		const registry = new ProviderRegistry(logger);
		registerPortkeyProvider(registry, logger);
		const models = await registry.getModelsForProvider("portkey", HOSTED_CREDENTIALS);

		expect(requests).toHaveLength(2);
		expect(models.map((m) => m.id)).toEqual(["@prod/claude-alias-1", "@prod/claude-alias-2"]);
	});

	it("deduplicates repeated ids within one page", async () => {
		const duplicate = {
			id: "@prod/claude-alias-1",
			canonical_slug: "claude-haiku-4-5",
		};
		const { requests } = stubFetchPages([{ data: [duplicate, duplicate], total: 2 }]);

		const registry = new ProviderRegistry(logger);
		registerPortkeyProvider(registry, logger);
		const models = await registry.getModelsForProvider("portkey", HOSTED_CREDENTIALS);

		expect(requests).toHaveLength(1);
		expect(models.map((m) => m.id)).toEqual(["@prod/claude-alias-1"]);
	});

	it("short-circuits OSS mode to no models without fetching", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const registry = new ProviderRegistry(logger);
		registerPortkeyProvider(registry, logger);
		const models = await registry.getModelsForProvider("portkey", OSS_CREDENTIALS);

		expect(models).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("yields no models and warns instructively on key-only credentials, without fetching", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const registry = new ProviderRegistry(logger);
		registerPortkeyProvider(registry, logger);
		const models = await registry.getModelsForProvider("portkey", {
			type: "apikey",
			apiKey: "pk-test",
		});

		expect(models).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("PORTKEY_BASE_URL"));
	});

	it("treats a non-empty key as the only credential requirement", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const registry = new ProviderRegistry(logger);
		registerPortkeyProvider(registry, logger);
		const models = await registry.getModelsForProvider("portkey", {
			type: "apikey",
			apiKey: "",
			baseUrl: "https://api.portkey.ai/v1",
		});

		expect(models).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Chat client
// ---------------------------------------------------------------------------

describe("portkey client factory", () => {
	const cancellationToken: CancellationToken = {
		isCancellationRequested: false,
		onCancellationRequested: () => ({ dispose() {} }),
	};

	interface CapturedChatRequest {
		url: string;
		headers: Headers;
	}

	/** Stub fetch, run one chat() with the given params, return the first request. */
	async function captureChatRequest(
		credentials: ApiKeyCredentials,
		params: Partial<ModelClientChatParams> & { model: string },
	): Promise<CapturedChatRequest> {
		const capture = createRawFetchCapture(
			async () =>
				new Response(JSON.stringify({ error: { message: "stop here" } }), {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", capture.mock);

		const registry = new ProviderRegistry(logger);
		registerPortkeyProvider(registry, logger);
		const client = registry.getClientForProvider("portkey", credentials);
		expect(client).not.toBeNull();
		try {
			const stream = await client!.chat({
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
		expect(capture.calls.length).toBeGreaterThan(0);
		const [input, init] = capture.call(0);
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
		return { url, headers };
	}

	it("dispatches anthropic-messages (and undefined) to the Anthropic delegate", async () => {
		const explicit = await captureChatRequest(HOSTED_CREDENTIALS, {
			model: "@anthropic-prod/claude-haiku-4-5",
			protocol: "anthropic-messages",
		});
		expect(explicit.url).toBe("https://api.portkey.ai/v1/messages");

		const dflt = await captureChatRequest(HOSTED_CREDENTIALS, {
			model: "@anthropic-prod/claude-haiku-4-5",
		});
		expect(dflt.url).toBe("https://api.portkey.ai/v1/messages");
	});

	it("sends the hosted key as x-portkey-api-key on both delegates, never as the native credential", async () => {
		// TODO(phase0-gate) contract: hosted auth is the provider-owned header;
		// native schemes carry only dummies.
		const anthropicReq = await captureChatRequest(HOSTED_CREDENTIALS, {
			model: "@anthropic-prod/claude-haiku-4-5",
			protocol: "anthropic-messages",
		});
		expect(anthropicReq.headers.get("x-portkey-api-key")).toBe("pk-test");
		expect(anthropicReq.headers.get("x-api-key")).not.toBe("pk-test");

		const openaiReq = await captureChatRequest(HOSTED_CREDENTIALS, {
			model: "@openai-prod/gpt-5-mini",
			protocol: "openai-chat",
		});
		expect(openaiReq.url).toBe("https://api.portkey.ai/v1/chat/completions");
		expect(openaiReq.headers.get("x-portkey-api-key")).toBe("pk-test");
		expect(openaiReq.headers.get("authorization")).not.toBe("Bearer pk-test");
	});

	it("dispatches openai-responses to /v1/responses", async () => {
		const req = await captureChatRequest(HOSTED_CREDENTIALS, {
			model: "@openai-prod/gpt-5-mini",
			protocol: "openai-responses",
		});
		expect(req.url).toBe("https://api.portkey.ai/v1/responses");
	});

	it("wires OSS credentials in each delegate's native scheme with the default routing header", async () => {
		const anthropicReq = await captureChatRequest(OSS_CREDENTIALS, {
			model: "claude-haiku-4-5",
			protocol: "anthropic-messages",
		});
		expect(anthropicReq.url).toBe("http://localhost:8787/v1/messages");
		expect(anthropicReq.headers.get("x-api-key")).toBe("sk-upstream");
		expect(anthropicReq.headers.get("x-portkey-provider")).toBe("anthropic");
		expect(anthropicReq.headers.get("x-portkey-api-key")).toBeNull();

		const openaiReq = await captureChatRequest(
			{ ...OSS_CREDENTIALS, customHeaders: { "X-Portkey-Provider": "openai" } },
			{ model: "gpt-5-mini", protocol: "openai-chat" },
		);
		expect(openaiReq.url).toBe("http://localhost:8787/v1/chat/completions");
		expect(openaiReq.headers.get("authorization")).toBe("Bearer sk-upstream");
		// User-supplied routing header wins over the anthropic default.
		expect(openaiReq.headers.get("x-portkey-provider")).toBe("openai");
	});

	it("drops config-supplied secret headers on chat (mixed case) while custom headers still flow", async () => {
		const req = await captureChatRequest(
			{
				...HOSTED_CREDENTIALS,
				customHeaders: {
					"X-Portkey-Api-Key": "attacker-key",
					"X-PORTKEY-VIRTUAL-KEY": "attacker-vk",
					"X-Tenant": "acme",
				},
			},
			{ model: "@anthropic-prod/claude-haiku-4-5", protocol: "anthropic-messages" },
		);
		expect(req.headers.get("x-portkey-api-key")).toBe("pk-test");
		expect(req.headers.get("x-portkey-virtual-key")).toBeNull();
		expect(req.headers.get("x-tenant")).toBe("acme");
	});

	it("rejects protocols with no portkey route, naming the model", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}")),
		);
		const registry = new ProviderRegistry(logger);
		registerPortkeyProvider(registry, logger);
		const client = registry.getClientForProvider("portkey", HOSTED_CREDENTIALS);
		await expect(
			client!.chat({
				model: "@anthropic-prod/claude-haiku-4-5",
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
				maxOutputTokens: 10,
				cancellationToken,
				protocol: "bedrock-converse",
			}),
		).rejects.toThrow(/@anthropic-prod\/claude-haiku-4-5.*bedrock-converse/);
	});

	it("throws the instructive missing-base-URL error at construction for key-only credentials", () => {
		const registry = new ProviderRegistry(logger);
		registerPortkeyProvider(registry, logger);
		expect(() =>
			registry.getClientForProvider("portkey", { type: "apikey", apiKey: "pk-test" }),
		).toThrow(/PORTKEY_BASE_URL[\s\S]*configure form/);
	});

	it("rejects an empty hosted key locally before chat makes a request", () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const registry = new ProviderRegistry(logger);
		registerCustomPortkeyProvider(registry, "acme-portkey", logger);

		expect(() =>
			registry.getClientForProviderOrKind(
				"acme-portkey",
				{ type: "apikey", apiKey: "", baseUrl: "https://api.portkey.ai/v1" },
				"portkey",
			),
		).toThrow(/hosted Portkey[\s\S]*non-empty API key/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("validates model-id shape per mode: hosted requires @slug/ ids, OSS requires bare ids", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const registry = new ProviderRegistry(logger);
		registerPortkeyProvider(registry, logger);

		const hosted = registry.getClientForProvider("portkey", HOSTED_CREDENTIALS);
		await expect(
			hosted!.chat({
				model: "claude-haiku-4-5",
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
				maxOutputTokens: 10,
				cancellationToken,
			}),
		).rejects.toThrow(/@provider-slug\/model/);

		const oss = registry.getClientForProvider("portkey", OSS_CREDENTIALS);
		await expect(
			oss!.chat({
				model: "@anthropic-prod/claude-haiku-4-5",
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
				maxOutputTokens: 10,
				cancellationToken,
			}),
		).rejects.toThrow(/bare upstream model ids/);

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects a cross-gateway per-request baseUrl override with no request", async () => {
		// Repro-style: a dispatcher that forwards the override would send this
		// connection's credentials to evil.example instead of throwing.
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const registry = new ProviderRegistry(logger);
		registerPortkeyProvider(registry, logger);
		const client = registry.getClientForProvider("portkey", HOSTED_CREDENTIALS);

		await expect(
			client!.chat({
				model: "@anthropic-prod/claude-haiku-4-5",
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
				maxOutputTokens: 10,
				cancellationToken,
				baseUrl: "https://evil.example/v1",
			}),
		).rejects.toThrow(
			/@anthropic-prod\/claude-haiku-4-5[\s\S]*evil\.example[\s\S]*api\.portkey\.ai/,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("accepts an equivalently-normalized same-gateway override and delegates with the resolver-owned URL", async () => {
		const req = await captureChatRequest(OSS_CREDENTIALS, {
			model: "claude-haiku-4-5",
			protocol: "anthropic-messages",
			baseUrl: "HTTP://LOCALHOST:8787/v1/",
		});
		expect(req.url).toBe("http://localhost:8787/v1/messages");
	});
});

// ---------------------------------------------------------------------------
// Gateway error-shape tolerance (OSS probes 2026-08-08, probe 6:
// plans/probe-findings-oss-2026-08-08.md). Non-standard error bodies the
// gateway actually produces must surface as a clear failed-request error
// (status + best-effort body text) via the stream's error part — not crash
// and not a blank/garbled message.
// ---------------------------------------------------------------------------

describe("portkey client — gateway error-shape tolerance", () => {
	const cancellationToken: CancellationToken = {
		isCancellationRequested: false,
		onCancellationRequested: () => ({ dispose() {} }),
	};

	/** Run one chat() against a mocked error response; collect stream parts. */
	async function chatAgainstErrorResponse(
		status: number,
		body: unknown,
		params: Partial<ModelClientChatParams> & { model: string },
	): Promise<Error> {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify(body), {
						status,
						// No statusText, like real HTTP/2 responses (no reason phrase).
						headers: { "content-type": "application/json" },
					}),
			),
		);
		const registry = new ProviderRegistry(logger);
		registerPortkeyProvider(registry, logger);
		const client = registry.getClientForProvider("portkey", OSS_CREDENTIALS);

		const errors: Error[] = [];
		const stream = await client!.chat({
			messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			maxOutputTokens: 10,
			cancellationToken,
			...params,
		});
		// The stream itself must not throw — errors arrive as error parts.
		for await (const part of stream) {
			if (part.type === "error" && part.error instanceof Error) {
				errors.push(part.error);
			}
		}
		expect(errors).toHaveLength(1);
		return errors[0];
	}

	it('surfaces the 401 {"html-message": …} shape (invalid upstream key) with status and body text', async () => {
		// Probe 6: invalid openai key through the OSS gateway → 401 with a body
		// that has no `error` key at all.
		const error = await chatAgainstErrorResponse(
			401,
			{ "html-message": '{"error":{"message":"Incorrect API key provided"}}' },
			{ model: "gpt-4o-mini", protocol: "openai-chat" },
		);
		expect(error.message).toContain("401");
		expect(error.message).toContain("Incorrect API key provided");
	});

	it('surfaces the gateway {"status":"failure",…} envelope with status and message text', async () => {
		// Probe 6: gateway-level failures (e.g. unknown x-portkey-provider →
		// 400) use the gateway's own envelope, not an OpenAI-shaped `error`.
		const error = await chatAgainstErrorResponse(
			400,
			{ status: "failure", message: "Invalid provider passed" },
			{ model: "claude-haiku-4-5", protocol: "anthropic-messages" },
		);
		expect(error.message).toContain("400");
		expect(error.message).toContain("Invalid provider passed");
	});
});
