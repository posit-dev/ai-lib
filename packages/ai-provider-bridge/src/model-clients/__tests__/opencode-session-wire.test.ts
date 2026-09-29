/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * OpenCode session-routing wire regressions.
 *
 * The built-in `opencode` provider owns the `x-opencode-session` header:
 * every chat request builds its protocol delegate with the host's root
 * conversation identity in `customHeaders`. These tests drive
 * registry-created `opencode` clients against a captured fetch and assert the
 * headers on the physical wire request — proving the header survives the full
 * provider → delegate → SDK pipeline, not just the provider's header helper.
 */

import type { ModelMessage } from "ai";
import { mintCustomProviderId, OPENCODE_GO_BASE_URL, OPENCODE_ZEN_BASE_URL } from "ai-config";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRawFetchCapture } from "../../../tests/helpers/raw-fetch-capture";
import { registerCustomOpenAICompatibleProvider } from "../../providers/openai-compatible-provider";
import { registerOpencodeProvider } from "../../providers/opencode-provider";
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

/** Create a built-in `opencode` client through the registry, as hosts do. */
function opencodeClient(credentials: ApiKeyCredentials): ModelClient {
	const registry = new ProviderRegistry(logger);
	registerOpencodeProvider(registry, logger);
	const client = registry.getClientForProviderOrKind("opencode", credentials, "openai");
	if (!client) {
		throw new Error("registry returned no client");
	}
	return client;
}

async function driveChat(
	client: ModelClient,
	params: {
		model?: string;
		baseUrl?: string;
		protocol?: Protocol;
		metadata?: { sessionId?: string; rootConversationId?: string };
	},
): Promise<void> {
	try {
		const stream = await client.chat({
			model: params.model ?? "model-1",
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
	// The basic contract, parameterized over the three delegate protocols and
	// both product roots: the root conversation ID rides as x-opencode-session
	// and authentication stays route-native.
	it.each([
		{ protocol: "openai-chat" as const, model: "model-1", baseUrl: OPENCODE_GO_BASE_URL },
		{ protocol: "openai-chat" as const, model: "model-1", baseUrl: OPENCODE_ZEN_BASE_URL },
		{ protocol: "openai-responses" as const, model: "model-1", baseUrl: OPENCODE_GO_BASE_URL },
		{ protocol: "openai-responses" as const, model: "model-1", baseUrl: OPENCODE_ZEN_BASE_URL },
		{
			protocol: "anthropic-messages" as const,
			model: "claude-opus-5",
			baseUrl: OPENCODE_GO_BASE_URL,
		},
		{
			protocol: "anthropic-messages" as const,
			model: "claude-opus-5",
			baseUrl: OPENCODE_ZEN_BASE_URL,
		},
		{
			protocol: "google-generative" as const,
			model: "gemini-3.8-flash",
			baseUrl: OPENCODE_GO_BASE_URL,
		},
		{
			protocol: "google-generative" as const,
			model: "gemini-3.8-flash",
			baseUrl: OPENCODE_ZEN_BASE_URL,
		},
	])(
		"sends the session header and route-native auth ($protocol -> $baseUrl)",
		async ({ protocol, model, baseUrl }) => {
			const capture = createRawFetchCapture(async () => sseResponse());
			vi.stubGlobal("fetch", capture.mock);

			const client = opencodeClient({ type: "apikey", apiKey: "sk-test", baseUrl });
			await driveChat(client, {
				model,
				protocol,
				metadata: { sessionId: "root-1:sub-1:classifier", rootConversationId: "root-1" },
			});

			const headers = capturedHeaders(capture.single());
			expect(headers.get("x-opencode-session")).toBe("root-1");
			// Authentication survives on the route's native scheme: OpenAI-family
			// sends Bearer, Messages x-api-key, generateContent x-goog-api-key.
			switch (protocol) {
				case "openai-chat":
				case "openai-responses":
					expect(headers.get("authorization")).toBe("Bearer sk-test");
					break;
				case "anthropic-messages":
					expect(headers.get("x-api-key")).toBe("sk-test");
					break;
				case "google-generative":
					expect(headers.get("x-goog-api-key")).toBe("sk-test");
					break;
			}
		},
	);

	it("keeps distinct session IDs for concurrent conversations sharing one client", async () => {
		const capture = createRawFetchCapture(async () => sseResponse());
		vi.stubGlobal("fetch", capture.mock);

		const client = opencodeClient({
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: OPENCODE_GO_BASE_URL,
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

	it("adds no generated header without root metadata, and a static one survives", async () => {
		const capture = createRawFetchCapture(async () => sseResponse());
		vi.stubGlobal("fetch", capture.mock);

		// No root metadata at all: no session header on the wire.
		const bare = opencodeClient({
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: OPENCODE_GO_BASE_URL,
		});
		await driveChat(bare, {});
		expect(capturedHeaders(capture.single()).get("x-opencode-session")).toBeNull();

		capture.mock.mockClear();

		// A static (mixed-case) custom header without root metadata survives
		// unchanged — the provider generates nothing and strips nothing.
		const withStatic = opencodeClient({
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: OPENCODE_GO_BASE_URL,
			customHeaders: { "X-OpenCode-Session": "static-workaround" },
		});
		await driveChat(withStatic, { metadata: { sessionId: "root-1" } });
		expect(capturedHeaders(capture.single()).get("x-opencode-session")).toBe("static-workaround");
	});

	it.each([{ protocol: "openai-chat" as const }, { protocol: "anthropic-messages" as const }])(
		"generated session header wins over a mixed-case static workaround ($protocol)",
		async ({ protocol }) => {
			const capture = createRawFetchCapture(async () => sseResponse());
			vi.stubGlobal("fetch", capture.mock);

			const client = opencodeClient({
				type: "apikey",
				apiKey: "sk-test",
				baseUrl: OPENCODE_GO_BASE_URL,
				customHeaders: { "X-OPENCODE-SESSION": "static-workaround" },
			});
			await driveChat(client, { protocol, metadata: { rootConversationId: "root-1" } });
			expect(capturedHeaders(capture.single()).get("x-opencode-session")).toBe("root-1");
		},
	);

	it("sends no session header from a custom openai-compatible provider at the OpenCode URL", async () => {
		// Behavior change: the header is owned by the built-in `opencode`
		// provider, not matched on the destination URL — a hand-configured
		// custom provider pointed at an OpenCode endpoint gets nothing.
		const capture = createRawFetchCapture(async () => sseResponse());
		vi.stubGlobal("fetch", capture.mock);

		const registry = new ProviderRegistry(logger);
		const id = mintCustomProviderId("opencode-host");
		registerCustomOpenAICompatibleProvider(registry, id, logger);
		const client = registry.getClientForProviderOrKind(
			id,
			{ type: "apikey", apiKey: "sk-test", baseUrl: OPENCODE_GO_BASE_URL },
			"openai-compatible",
		);
		if (!client) {
			throw new Error("registry returned no client");
		}
		await driveChat(client, { metadata: { rootConversationId: "root-1" } });

		expect(capturedHeaders(capture.single()).get("x-opencode-session")).toBeNull();
	});
});
