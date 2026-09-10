/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * OpenCode session-routing wire regressions.
 *
 * OpenCode's hosted services (Go at `https://opencode.ai/zen/go/v1`, Zen at
 * `https://opencode.ai/zen/v1`) require a stable conversation identity in the
 * `x-opencode-session` header and a product User-Agent. These tests drive
 * registry-created custom-provider clients against a captured fetch and
 * assert the headers on the physical wire request — proving the header
 * survives the full client → SDK → middleware pipeline, not just the policy
 * helper's return value.
 *
 * URL matching/normalization is covered by a compact table in
 * `opencode-request-headers.test.ts`; this file keeps the wire-level
 * behavioral contracts.
 */

import type { ModelMessage } from "ai";
import { mintCustomProviderId } from "ai-config";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRawFetchCapture } from "../../../tests/helpers/raw-fetch-capture";
import { registerCustomAnthropicProvider } from "../../providers/anthropic-provider";
import { registerCustomOpenAICompatibleProvider } from "../../providers/openai-compatible-provider";
import { ProviderRegistry } from "../../providers/ProviderRegistry";
import type {
	ApiKeyCredentials,
	CancellationToken,
	Logger,
	ModelClient,
	Protocol,
} from "../../types";

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

const GO_BASE_URL = "https://opencode.ai/zen/go/v1";
const ZEN_BASE_URL = "https://opencode.ai/zen/v1";

const MESSAGES: ModelMessage[] = [{ role: "user", content: "Hello" }];

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function sseResponse(): Response {
	return new Response("data: [DONE]\n\n", {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function modelsResponse(): Response {
	return new Response(JSON.stringify({ data: [{ id: "model-1", object: "model" }] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

/** Create a custom-provider client through the registry, as hosts do. */
function customClient(
	kind: "openai-compatible" | "anthropic",
	credentials: ApiKeyCredentials,
	userAgent?: string,
): ModelClient {
	const registry = new ProviderRegistry(logger);
	const id = mintCustomProviderId("opencode-host");
	if (kind === "openai-compatible") {
		registerCustomOpenAICompatibleProvider(registry, id, logger, userAgent);
	} else {
		registerCustomAnthropicProvider(registry, id, logger, userAgent);
	}
	const client = registry.getClientForProviderOrKind(id, credentials, kind);
	if (!client) {
		throw new Error("registry returned no client");
	}
	return client;
}

async function driveChat(
	client: ModelClient,
	params: {
		baseUrl?: string;
		protocol?: Protocol;
		metadata?: { sessionId?: string; rootConversationId?: string };
	},
): Promise<void> {
	try {
		const stream = await client.chat({
			model: "model-1",
			messages: MESSAGES,
			cancellationToken,
			baseUrl: params.baseUrl,
			protocol: params.protocol,
			metadata: params.metadata,
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

describe("OpenCode session header (wire)", () => {
	// The basic contract, parameterized over the three supported protocols and
	// both endpoint roots: the root conversation ID rides as x-opencode-session,
	// the host product User-Agent leads, and authentication is untouched.
	it.each([
		{ kind: "openai-compatible" as const, protocol: "openai-chat" as const, baseUrl: GO_BASE_URL },
		{ kind: "openai-compatible" as const, protocol: "openai-chat" as const, baseUrl: ZEN_BASE_URL },
		{
			kind: "openai-compatible" as const,
			protocol: "openai-responses" as const,
			baseUrl: GO_BASE_URL,
		},
		{
			kind: "openai-compatible" as const,
			protocol: "openai-responses" as const,
			baseUrl: ZEN_BASE_URL,
		},
		{ kind: "anthropic" as const, protocol: undefined, baseUrl: GO_BASE_URL },
		{ kind: "anthropic" as const, protocol: undefined, baseUrl: ZEN_BASE_URL },
	])(
		"sends session header, host User-Agent, and auth ($kind $protocol -> $baseUrl)",
		async ({ kind, protocol, baseUrl }) => {
			const capture = createRawFetchCapture(async () => sseResponse());
			vi.stubGlobal("fetch", capture.mock);

			const client = customClient(
				kind,
				{ type: "apikey", apiKey: "sk-test", baseUrl },
				HOST_USER_AGENT,
			);
			await driveChat(client, {
				protocol,
				metadata: { sessionId: "root-1:sub-1:classifier", rootConversationId: "root-1" },
			});

			const headers = capturedHeaders(capture.single());
			expect(headers.get("x-opencode-session")).toBe("root-1");
			// The AI SDK appends its own product tokens after a caller-supplied
			// User-Agent; the host identity must lead.
			expect(headers.get("user-agent")?.startsWith(HOST_USER_AGENT)).toBe(true);
			// Authentication survives: OpenAI-family sends Bearer, Anthropic x-api-key.
			const auth =
				headers.get("authorization") ??
				(headers.get("x-api-key") ? `x-api-key:${headers.get("x-api-key")}` : null);
			expect(auth === "Bearer sk-test" || auth === "x-api-key:sk-test").toBe(true);
		},
	);

	it("keeps distinct session IDs for concurrent conversations sharing one client", async () => {
		const capture = createRawFetchCapture(async () => sseResponse());
		vi.stubGlobal("fetch", capture.mock);

		const client = customClient("openai-compatible", {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: GO_BASE_URL,
		});
		await Promise.all([
			driveChat(client, { metadata: { rootConversationId: "root-a" } }),
			driveChat(client, { metadata: { rootConversationId: "root-b" } }),
		]);

		expect(capture.calls).toHaveLength(2);
		const sessionHeaders = capture.calls.map((call) =>
			capturedHeaders(call).get("x-opencode-session"),
		);
		expect(sessionHeaders.sort()).toEqual(["root-a", "root-b"]);
	});

	it("follows a per-request endpoint override onto and away from OpenCode", async () => {
		const capture = createRawFetchCapture(async () => sseResponse());
		vi.stubGlobal("fetch", capture.mock);

		// Constructor points elsewhere; the override routes to OpenCode.
		const onto = customClient("openai-compatible", {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: "https://api.example.com/v1",
		});
		await driveChat(onto, {
			baseUrl: GO_BASE_URL,
			metadata: { rootConversationId: "root-1" },
		});
		expect(capturedHeaders(capture.single()).get("x-opencode-session")).toBe("root-1");

		capture.mock.mockClear();

		// Constructor points at OpenCode; the override routes away.
		const away = customClient("openai-compatible", {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: GO_BASE_URL,
		});
		await driveChat(away, {
			baseUrl: "https://api.example.com/v1",
			metadata: { rootConversationId: "root-1" },
		});
		expect(capturedHeaders(capture.single()).get("x-opencode-session")).toBeNull();
	});

	it("does not match lookalike hosts", async () => {
		const capture = createRawFetchCapture(async () => sseResponse());
		vi.stubGlobal("fetch", capture.mock);

		for (const baseUrl of [
			"https://opencode.ai.evil.example.com/zen/go/v1",
			"https://sub.opencode.ai/zen/go/v1",
			"http://opencode.ai/zen/go/v1",
		]) {
			const client = customClient("openai-compatible", {
				type: "apikey",
				apiKey: "sk-test",
				baseUrl,
			});
			await driveChat(client, { metadata: { rootConversationId: "root-1" } });
		}

		expect(capture.calls).toHaveLength(3);
		for (const call of capture.calls) {
			expect(capturedHeaders(call).get("x-opencode-session")).toBeNull();
		}
	});

	it("adds no generated header without root metadata, and never strips a static one", async () => {
		const capture = createRawFetchCapture(async () => sseResponse());
		vi.stubGlobal("fetch", capture.mock);

		// Matching route, no root metadata: no generated session header, and the
		// user's static (mixed-case) header survives unchanged.
		const matching = customClient("openai-compatible", {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: GO_BASE_URL,
			customHeaders: { "X-OpenCode-Session": "static-workaround" },
		});
		await driveChat(matching, { metadata: { sessionId: "root-1" } });

		let headers = capturedHeaders(capture.single());
		expect(headers.get("x-opencode-session")).toBe("static-workaround");

		capture.mock.mockClear();

		// Unrelated endpoint: the static header survives there too.
		const unrelated = customClient("openai-compatible", {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: "https://api.example.com/v1",
			customHeaders: { "X-OpenCode-Session": "static-workaround" },
		});
		await driveChat(unrelated, { metadata: { rootConversationId: "root-1" } });

		headers = capturedHeaders(capture.single());
		expect(headers.get("x-opencode-session")).toBe("static-workaround");
	});

	it("generated session header wins over a mixed-case static workaround", async () => {
		const capture = createRawFetchCapture(async () => sseResponse());
		vi.stubGlobal("fetch", capture.mock);

		// OpenAI-compatible merge path: the SDK-level generated header makes the
		// middleware's additive custom-header merge skip the static entry.
		const compatible = customClient("openai-compatible", {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: GO_BASE_URL,
			customHeaders: { "X-OPENCODE-SESSION": "static-workaround" },
		});
		await driveChat(compatible, { metadata: { rootConversationId: "root-1" } });
		expect(capturedHeaders(capture.single()).get("x-opencode-session")).toBe("root-1");

		capture.mock.mockClear();

		// Direct SDK merge path (Anthropic): the policy replaces the case-variant
		// in the SDK-bound header record.
		const direct = customClient("anthropic", {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: ZEN_BASE_URL,
			customHeaders: { "X-OPENCODE-SESSION": "static-workaround" },
		});
		await driveChat(direct, { metadata: { rootConversationId: "root-1" } });
		expect(capturedHeaders(capture.single()).get("x-opencode-session")).toBe("root-1");
	});

	it("explicit mixed-case User-Agent wins over the host identity on both merge paths", async () => {
		const capture = createRawFetchCapture(async () => sseResponse());
		vi.stubGlobal("fetch", capture.mock);

		const compatible = customClient(
			"openai-compatible",
			{
				type: "apikey",
				apiKey: "sk-test",
				baseUrl: GO_BASE_URL,
				customHeaders: { "USER-AGENT": "my-gateway/9.9" },
			},
			HOST_USER_AGENT,
		);
		await driveChat(compatible, { metadata: { rootConversationId: "root-1" } });
		expect(capturedHeaders(capture.single()).get("user-agent")).toContain("my-gateway/9.9");

		capture.mock.mockClear();

		const direct = customClient(
			"anthropic",
			{
				type: "apikey",
				apiKey: "sk-test",
				baseUrl: ZEN_BASE_URL,
				customHeaders: { "User-Agent": "my-gateway/9.9" },
			},
			HOST_USER_AGENT,
		);
		await driveChat(direct, { metadata: { rootConversationId: "root-1" } });
		expect(capturedHeaders(capture.single()).get("user-agent")).toContain("my-gateway/9.9");
	});

	it("keeps the SDK default User-Agent when no host identity is supplied", async () => {
		const capture = createRawFetchCapture(async () => sseResponse());
		vi.stubGlobal("fetch", capture.mock);

		const client = customClient("openai-compatible", {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: GO_BASE_URL,
		});
		await driveChat(client, { metadata: { rootConversationId: "root-1" } });

		const headers = capturedHeaders(capture.single());
		expect(headers.get("x-opencode-session")).toBe("root-1");
		expect(headers.get("user-agent")).not.toBeNull();
		expect(headers.get("user-agent")).not.toContain("PositAssistant");
	});
});

describe("OpenCode model discovery (wire)", () => {
	it("carries the host User-Agent and no session header on matching discovery", async () => {
		const capture = createRawFetchCapture(async () => modelsResponse());
		vi.stubGlobal("fetch", capture.mock);

		const registry = new ProviderRegistry(logger);
		const id = mintCustomProviderId("opencode-host");
		registerCustomOpenAICompatibleProvider(registry, id, logger, HOST_USER_AGENT);

		const models = await registry.getModelsForProvider(id, {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: GO_BASE_URL,
		});

		expect(models.map((model) => model.id)).toEqual(["model-1"]);
		const [url, init] = capture.single();
		expect(url).toBe(`${GO_BASE_URL}/models`);
		const headers = new Headers(init?.headers);
		expect(headers.get("user-agent")).toBe(HOST_USER_AGENT);
		expect(headers.get("x-opencode-session")).toBeNull();
		expect(headers.get("authorization")).toBe("Bearer sk-test");
	});

	it("lets an explicit custom User-Agent win on discovery", async () => {
		const capture = createRawFetchCapture(async () => modelsResponse());
		vi.stubGlobal("fetch", capture.mock);

		const registry = new ProviderRegistry(logger);
		const id = mintCustomProviderId("opencode-host");
		registerCustomOpenAICompatibleProvider(registry, id, logger, HOST_USER_AGENT);

		await registry.getModelsForProvider(id, {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: ZEN_BASE_URL,
			customHeaders: { "User-Agent": "my-gateway/9.9" },
		});

		const headers = new Headers(capture.single()[1]?.headers);
		expect(headers.get("user-agent")).toBe("my-gateway/9.9");
	});

	it("leaves non-OpenCode discovery untouched", async () => {
		const capture = createRawFetchCapture(async () => modelsResponse());
		vi.stubGlobal("fetch", capture.mock);

		const registry = new ProviderRegistry(logger);
		const id = mintCustomProviderId("corp");
		registerCustomOpenAICompatibleProvider(registry, id, logger, HOST_USER_AGENT);

		await registry.getModelsForProvider(id, {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: "https://api.example.com/v1",
		});

		const headers = new Headers(capture.single()[1]?.headers);
		expect(headers.get("user-agent")).toBeNull();
		expect(headers.get("x-opencode-session")).toBeNull();
	});
});
