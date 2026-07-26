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

import { ProviderRegistry } from "../../providers/ProviderRegistry";
import {
	registerSnowflakeCortexProvider,
	type SnowflakeProviderCallbacks,
} from "../../providers/snowflake-cortex-provider";
import type { CancellationToken, Logger, ProviderCredentials } from "../../types";
import type { ModelClient, ModelClientChatParams } from "../ModelClient";
import { SnowflakeClient, type SnowflakeSessionRefresh } from "../SnowflakeClient";

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

const mockLogger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

const BASE_URL = "https://acct.snowflakecomputing.com/api/v2/cortex";
const SESSION_TOKEN = "sess-tok-123";

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

describe("SnowflakeClient auth schemes", () => {
	beforeEach(() => {
		createAnthropic.mockClear();
		createOpenAI.mockClear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("bearer scheme: Anthropic route uses authToken, no fetch override, forwards custom headers verbatim", async () => {
		await new SnowflakeClient("bearer-xyz", BASE_URL, "bearer", { "x-gateway": "keep-me" }).chat(
			params(CLAUDE_MODEL),
		);

		const opts = anthropicOptions();
		expect(opts.authToken).toBe("bearer-xyz");
		expect(opts.apiKey).toBeUndefined();
		expect(opts.fetch).toBeUndefined();
		// customHeaders are additive gateway headers only — passed through untouched.
		expect(opts.headers).toEqual({ "x-gateway": "keep-me" });
	});

	it("session scheme: Anthropic route sends `Snowflake Token=` auth and strips x-api-key", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));

		await new SnowflakeClient(SESSION_TOKEN, BASE_URL, "session", { "x-gateway": "keep-me" }).chat(
			params(CLAUDE_MODEL),
		);

		const opts = anthropicOptions();
		// The placeholder key satisfies the SDK; real auth is applied by the wrapper.
		expect(opts.apiKey).toBe("session-auth");
		expect(opts.authToken).toBeUndefined();
		expect(opts.headers).toEqual({ "x-gateway": "keep-me" });

		// Drive the installed fetch wrapper as the SDK would (SDK sets x-api-key).
		await opts.fetch?.("https://x/v1/messages", {
			headers: { "x-api-key": "session-auth" },
		});

		const sent = outgoingHeaders(fetchSpy);
		expect(sent.get("authorization")).toBe(`Snowflake Token="${SESSION_TOKEN}"`);
		expect(sent.has("x-api-key")).toBe(false);
	});

	it("session scheme: OpenAI route sends `Snowflake Token=` auth through the compat fetch and keeps gateway headers", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(null, { headers: { "content-type": "application/json" } }));

		await new SnowflakeClient(SESSION_TOKEN, BASE_URL, "session", { "x-gateway": "keep-me" }).chat(
			params(OPENAI_MODEL),
		);

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
		// The additive gateway header still reaches the wire.
		expect(sent.get("x-gateway")).toBe("keep-me");
	});
});

// Cover the production seam in the registered client factory: the mapping from
// the `credentials.snowflake` group to the client's auth scheme. Constructing
// SnowflakeClient directly (above) bypasses this, so a factory regression could
// leave the client tests green while the product silently uses Bearer auth.
describe("Snowflake provider factory seam", () => {
	function createClient(credentials: ProviderCredentials): ModelClient {
		const registry = new ProviderRegistry(mockLogger);
		registerSnowflakeCortexProvider(registry, mockLogger);
		const client = registry.getClientForProvider("snowflake-cortex", credentials);
		if (!client) throw new Error("expected a Snowflake client from the factory");
		return client;
	}

	beforeEach(() => {
		createAnthropic.mockClear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("maps a present `snowflake` group to session auth (`Snowflake Token=`)", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));

		const client = createClient({
			type: "apikey",
			apiKey: SESSION_TOKEN,
			baseUrl: BASE_URL,
			snowflake: { sessionConnectionIdentity: "dev" },
		});
		await client.chat(params(CLAUDE_MODEL));

		const opts = anthropicOptions();
		expect(opts.apiKey).toBe("session-auth");
		expect(opts.authToken).toBeUndefined();

		await opts.fetch?.("https://x/v1/messages", { headers: { "x-api-key": "session-auth" } });
		expect(outgoingHeaders(fetchSpy).get("authorization")).toBe(
			`Snowflake Token="${SESSION_TOKEN}"`,
		);
	});

	it("maps an unflagged credential to Bearer auth", async () => {
		const client = createClient({ type: "apikey", apiKey: "bearer-xyz", baseUrl: BASE_URL });
		await client.chat(params(CLAUDE_MODEL));

		const opts = anthropicOptions();
		expect(opts.authToken).toBe("bearer-xyz");
		expect(opts.fetch).toBeUndefined();
	});
});

// Session-token expiry (390112) detect + retry in the fetch wrapper. Cortex
// returns HTTP 200 with a `390112` body when a session token has expired; the
// wrapper must reauthenticate the *client-bound* connection and retry once,
// transparently, on the pre-stream case (see the plan's Phase 5 decision gate).
describe("SnowflakeClient session-token expiry (390112)", () => {
	const REFRESH_IDENTITY = "dev";
	const FRESH_TOKEN = "fresh-session-tok";
	const EXPIRED_BODY = JSON.stringify({ code: "390112", message: "session token has expired" });

	beforeEach(() => {
		createAnthropic.mockClear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function refresh(
		reauthenticate: SnowflakeSessionRefresh["reauthenticate"],
	): SnowflakeSessionRefresh {
		return { connectionIdentity: REFRESH_IDENTITY, reauthenticate };
	}

	/** Build the client's installed fetch wrapper for the Anthropic route. */
	async function sessionFetch(sessionRefresh: SnowflakeSessionRefresh): Promise<SdkFetch> {
		await new SnowflakeClient(SESSION_TOKEN, BASE_URL, "session", undefined, sessionRefresh).chat(
			params(CLAUDE_MODEL),
		);
		const wrapper = anthropicOptions().fetch;
		if (!wrapper) throw new Error("expected a session fetch wrapper");
		return wrapper;
	}

	function authHeader(spy: ReturnType<typeof vi.spyOn>, callIndex: number): string | null {
		return new Headers((spy.mock.calls[callIndex]?.[1] as RequestInit | undefined)?.headers).get(
			"authorization",
		);
	}

	it("pre-stream 390112: reauthenticates the client-bound connection and retries once with the fresh token", async () => {
		const reauthenticate = vi.fn(async () => FRESH_TOKEN);
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(EXPIRED_BODY, { status: 200 }))
			.mockResolvedValueOnce(new Response("data: ok\n\n", { status: 200 }));

		const wrapper = await sessionFetch(refresh(reauthenticate));
		const result = await wrapper("https://x/v1/messages", {
			headers: { "x-api-key": "session-auth" },
		});

		// Refreshed *this* connection, not whatever might be selected.
		expect(reauthenticate).toHaveBeenCalledWith(REFRESH_IDENTITY);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		// First attempt used the original token; the retry used the refreshed one.
		expect(authHeader(fetchSpy, 0)).toBe(`Snowflake Token="${SESSION_TOKEN}"`);
		expect(authHeader(fetchSpy, 1)).toBe(`Snowflake Token="${FRESH_TOKEN}"`);
		// The caller receives the successful retry stream, not the 390112 body.
		expect(await result.text()).toContain("ok");
	});

	it("split-across-chunks 390112: still detected when the error code straddles a chunk boundary", async () => {
		// HTTP body chunking is arbitrary: a pre-stream error envelope can arrive
		// split so the `390112` code straddles a boundary (`{"code":"390` / `112"}`).
		// A first-chunk-only peek would miss it and hand the error to the SDK as a
		// bogus success; the bounded scan must reassemble and detect it.
		const encoder = new TextEncoder();
		const splitBody = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('{"code":"390'));
				controller.enqueue(encoder.encode('112","message":"session token has expired"}'));
				controller.close();
			},
		});
		const reauthenticate = vi.fn(async () => FRESH_TOKEN);
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(splitBody, { status: 200 }))
			.mockResolvedValueOnce(new Response("data: ok\n\n", { status: 200 }));

		const wrapper = await sessionFetch(refresh(reauthenticate));
		const result = await wrapper("https://x/v1/messages", {
			headers: { "x-api-key": "session-auth" },
		});

		expect(reauthenticate).toHaveBeenCalledWith(REFRESH_IDENTITY);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(authHeader(fetchSpy, 1)).toBe(`Snowflake Token="${FRESH_TOKEN}"`);
		expect(await result.text()).toContain("ok");
	});

	it("success stream: passes the body through untouched and never reauthenticates", async () => {
		const reauthenticate = vi.fn(async () => FRESH_TOKEN);
		const body = "data: hello\n\ndata: world\n\n";
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(body, { status: 200 }));

		const wrapper = await sessionFetch(refresh(reauthenticate));
		const result = await wrapper("https://x/v1/messages", {
			headers: { "x-api-key": "session-auth" },
		});

		expect(reauthenticate).not.toHaveBeenCalled();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		// The peeked first chunk is replayed in full — no dropped or duplicated bytes.
		expect(await result.text()).toBe(body);
	});

	it("multi-chunk success stream: replays every buffered chunk in order, losslessly", async () => {
		// A success stream whose leading bytes span several small chunks must be
		// replayed byte-for-byte and in order — the bounded scan buffers them while
		// ruling expiry out, then hands them back unchanged.
		const encoder = new TextEncoder();
		const parts = ["data: he", "llo\n\n", "data: wor", "ld\n\n"];
		const chunked = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const part of parts) controller.enqueue(encoder.encode(part));
				controller.close();
			},
		});
		const reauthenticate = vi.fn(async () => FRESH_TOKEN);
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(chunked, { status: 200 }));

		const wrapper = await sessionFetch(refresh(reauthenticate));
		const result = await wrapper("https://x/v1/messages", {
			headers: { "x-api-key": "session-auth" },
		});

		expect(reauthenticate).not.toHaveBeenCalled();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(await result.text()).toBe(parts.join(""));
	});

	it("reauth failure: surfaces the original 390112 error and does not retry", async () => {
		const reauthenticate = vi.fn(async () => {
			throw new Error("SSO window closed");
		});
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(EXPIRED_BODY, { status: 200 }));

		const wrapper = await sessionFetch(refresh(reauthenticate));
		const result = await wrapper("https://x/v1/messages", {
			headers: { "x-api-key": "session-auth" },
		});

		expect(reauthenticate).toHaveBeenCalledTimes(1);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		// Original error body is preserved for the caller to surface.
		expect(await result.text()).toContain("390112");
	});

	it("factory seam: the client-bound identity comes from the credentials, not the current selection", async () => {
		// A client built from connection "A" must refresh "A" even though the hook
		// is a generic "refresh whatever identity you're given" — the identity is
		// captured from the credential at construction, so a later selection of "B"
		// cannot redirect this in-flight request's retry.
		const reauthenticate = vi.fn(async () => FRESH_TOKEN);
		const callbacks: SnowflakeProviderCallbacks = { reauthenticateSession: reauthenticate };
		const registry = new ProviderRegistry(mockLogger);
		registerSnowflakeCortexProvider(registry, mockLogger, callbacks);
		const client = registry.getClientForProvider("snowflake-cortex", {
			type: "apikey",
			apiKey: SESSION_TOKEN,
			baseUrl: BASE_URL,
			snowflake: { sessionConnectionIdentity: "A" },
		});
		if (!client) throw new Error("expected a Snowflake client from the factory");

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(EXPIRED_BODY, { status: 200 }))
			.mockResolvedValueOnce(new Response("data: ok\n\n", { status: 200 }));

		await client.chat(params(CLAUDE_MODEL));
		await anthropicOptions().fetch?.("https://x/v1/messages", {
			headers: { "x-api-key": "session-auth" },
		});

		expect(reauthenticate).toHaveBeenCalledWith("A");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});
});
