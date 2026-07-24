/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the options each SDK factory receives so we can assert on the auth
// scheme and drive the installed fetch wrapper. `vi.hoisted` lets these mocks
// exist before the hoisted `vi.mock` factories run.
const { createAnthropic, createOpenAI } = vi.hoisted(() => ({
	createAnthropic: vi.fn(() => vi.fn(() => ({}))),
	createOpenAI: vi.fn(() => ({ chat: vi.fn(() => ({})) })),
}));

vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI }));
vi.mock("ai", () => ({ streamText: vi.fn(() => ({ fullStream: {} })) }));
// Bypass the stream-conversion + abort plumbing; we only care about the auth
// headers the client's fetch wrapper produces.
vi.mock("../ai-sdk-helpers", () => ({
	convertAiSdkStreamToPlatform: vi.fn(() => (async function* () {})()),
	createAbortControllerFromToken: vi.fn(() => ({
		abortController: new AbortController(),
		cleanup: vi.fn(),
	})),
	createStepLogger: vi.fn(() => undefined),
}));

import type { CancellationToken } from "../../types";
import type { ModelClientChatParams } from "../ModelClient";
import { SnowflakeClient } from "../SnowflakeClient";

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

const BASE_URL = "https://acct.snowflakecomputing.com/api/v2/cortex";
const SESSION_TOKEN = "sess-tok-123";
const TOKEN_TYPE_HEADER = "X-Snowflake-Authorization-Token-Type";

// Claude models route through the Anthropic Messages API; others through OpenAI.
const CLAUDE_MODEL = "claude-opus-4-7";
const OPENAI_MODEL = "openai-gpt-5.2";

type SdkFetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface AnthropicOptions {
	apiKey?: string;
	authToken?: string;
	baseURL?: string;
	fetch?: SdkFetch;
	headers?: Record<string, string>;
}

interface OpenAIOptions {
	apiKey?: string;
	baseURL?: string;
	fetch?: SdkFetch;
}

function anthropicOptions(): AnthropicOptions {
	return createAnthropic.mock.calls[0]?.[0] as AnthropicOptions;
}

function openaiOptions(): OpenAIOptions {
	return createOpenAI.mock.calls[0]?.[0] as OpenAIOptions;
}

const params = (model: string): ModelClientChatParams => ({
	model,
	messages: [],
	maxOutputTokens: 1024,
	cancellationToken,
});

/** Headers seen by the terminal `globalThis.fetch` after the wrappers run. */
function outgoingHeaders(spy: ReturnType<typeof vi.spyOn>): Headers {
	return new Headers((spy.mock.calls[0]?.[1] as RequestInit | undefined)?.headers);
}

describe("SnowflakeClient session-token auth", () => {
	beforeEach(() => {
		createAnthropic.mockClear();
		createOpenAI.mockClear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("Anthropic route uses Bearer authToken (no fetch override) without the sentinel", async () => {
		await new SnowflakeClient("bearer-xyz", BASE_URL).chat(params(CLAUDE_MODEL));

		const opts = anthropicOptions();
		expect(opts.authToken).toBe("bearer-xyz");
		expect(opts.apiKey).toBeUndefined();
		expect(opts.fetch).toBeUndefined();
	});

	it("Anthropic route sends `Snowflake Token=` auth and strips the sentinel + x-api-key", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));

		await new SnowflakeClient(SESSION_TOKEN, BASE_URL, {
			[TOKEN_TYPE_HEADER]: "SESSION",
			"x-gateway": "keep-me",
		}).chat(params(CLAUDE_MODEL));

		const opts = anthropicOptions();
		// The placeholder key satisfies the SDK; real auth is applied by the wrapper.
		expect(opts.apiKey).toBe("session-auth");
		expect(opts.authToken).toBeUndefined();
		// Additive custom header is forwarded; the internal sentinel is not.
		expect(opts.headers).toEqual({ "x-gateway": "keep-me" });

		// Drive the installed fetch wrapper as the SDK would (SDK sets x-api-key).
		await opts.fetch?.("https://x/v1/messages", {
			headers: { "x-api-key": "session-auth", [TOKEN_TYPE_HEADER]: "SESSION" },
		});

		const sent = outgoingHeaders(fetchSpy);
		expect(sent.get("authorization")).toBe(`Snowflake Token="${SESSION_TOKEN}"`);
		expect(sent.has("x-api-key")).toBe(false);
		expect(sent.has(TOKEN_TYPE_HEADER)).toBe(false);
	});

	it("OpenAI route sends `Snowflake Token=` auth through the compat fetch and keeps gateway headers", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(null, { headers: { "content-type": "application/json" } }));

		await new SnowflakeClient(SESSION_TOKEN, BASE_URL, {
			[TOKEN_TYPE_HEADER]: "SESSION",
			"x-gateway": "keep-me",
		}).chat(params(OPENAI_MODEL));

		const opts = openaiOptions();
		expect(opts.fetch).toBeDefined();

		await opts.fetch?.("https://x/chat/completions", {
			headers: { Authorization: "Bearer session-auth", "x-api-key": "session-auth" },
			body: JSON.stringify({ max_tokens: 10, messages: [] }),
		});

		const sent = outgoingHeaders(fetchSpy);
		// Session wrapper installs `Snowflake Token=` last, over the SDK's Bearer.
		expect(sent.get("authorization")).toBe(`Snowflake Token="${SESSION_TOKEN}"`);
		expect(sent.has("x-api-key")).toBe(false);
		expect(sent.has(TOKEN_TYPE_HEADER)).toBe(false);
		// The additive gateway header still reaches the wire.
		expect(sent.get("x-gateway")).toBe("keep-me");
	});

	it("recognizes the session sentinel regardless of header-name casing", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));

		// Lowercase spelling — HTTP header names are case-insensitive.
		await new SnowflakeClient(SESSION_TOKEN, BASE_URL, {
			"x-snowflake-authorization-token-type": "SESSION",
		}).chat(params(CLAUDE_MODEL));

		const opts = anthropicOptions();
		expect(opts.apiKey).toBe("session-auth");
		expect(opts.authToken).toBeUndefined();
		expect(opts.fetch).toBeDefined();
		// The sentinel was the only custom header; nothing remains to forward.
		expect(opts.headers).toBeUndefined();
	});
});
