/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Snowflake Cortex API Client
 *
 * Implements ModelClient interface for Snowflake Cortex models.
 * Routes internally based on model ID:
 * - Claude models → Anthropic Messages API
 * - All others → OpenAI Chat Completions API
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";

import { safeSdkCustomHeaders } from "../custom-headers";
import { streamTextAnthropicWire } from "../tool-call-ids";
import type { LMStreamPart, Logger } from "../types";
import { normalizeProtocol } from "../types";
import { isClaudeModel, isThinkingEnabled, rejectsEagerInputStreaming } from "../utils";
import {
	convertAiSdkStreamToPlatform,
	createAbortControllerFromToken,
	createStepLogger,
} from "./ai-sdk-helpers";
import type { ModelClient, ModelClientChatParams } from "./ModelClient";
import { createOpenAICompatibleFetch } from "./openai-compat-fetch";

/**
 * How the credential's token authenticates with Snowflake Cortex:
 * - `"bearer"`: an API/PAT token sent as `Authorization: Bearer` (or `x-api-key`).
 * - `"session"`: a session token (external-browser SSO) sent as
 *   `Authorization: Snowflake Token="..."`.
 */
export type SnowflakeAuthScheme = "bearer" | "session";

type FetchFn = (url: string | URL | globalThis.Request, init?: RequestInit) => Promise<Response>;

/**
 * Reauthenticate an expired Snowflake **session** for a specific client-bound
 * connection identity, returning a fresh session token. Pre-built by the Node
 * caller and threaded in via the provider factory; the bridge never constructs
 * it. Only session auth uses it.
 */
export type SnowflakeSessionReauth = (sessionConnectionIdentity: string) => Promise<string>;

/**
 * Client-bound session refresh: which connections.toml connection this client's
 * token was acquired from, and how to reauthenticate *it* (not whatever
 * connection is currently selected) when its session token expires mid-request.
 */
export interface SnowflakeSessionRefresh {
	connectionIdentity: string;
	reauthenticate: SnowflakeSessionReauth;
}

/**
 * Snowflake error code for an expired — but renewable — session token. Cortex
 * returns it with HTTP 200 and does not perform the operation, so it must be
 * detected on the response body, not the status.
 */
const SESSION_EXPIRED_CODE = "390112";

/** True if a Cortex response body signals an expired session token (390112). */
function isSessionExpiredBody(bodyText: string): boolean {
	// `"code"` may be a JSON string ("390112") or number (390112) — match both.
	return new RegExp(`"code"\\s*:\\s*"?${SESSION_EXPIRED_CODE}"?`).test(bodyText);
}

/** Copy headers, dropping framing headers invalidated by rebuilding the body. */
function headersWithoutFraming(headers: Headers): Headers {
	const copy = new Headers(headers);
	copy.delete("content-length");
	copy.delete("content-encoding");
	return copy;
}

/**
 * Classify a Cortex response as a **pre-stream** `390112` (expired session) error
 * without disturbing the streaming success path.
 *
 * Per the Cortex REST contract a response is either a `text/event-stream` (the
 * model output) or a JSON error envelope — so branching on the content type is
 * exact. A stream is returned **untouched**: the wrapper never reads it, so there
 * is no first-token latency, and model output is never scanned for an error code
 * that could legitimately appear inside it. Any non-stream response is a small
 * envelope: it is buffered in full (so a body split across transport chunks is
 * still whole), checked for `390112`, and rebuilt so the SDK — or the reauth
 * failure path — can still read it.
 *
 * A `390112` that instead appeared mid-SSE after emitted output would not be
 * caught here — by policy that case surfaces as a retryable failure rather than
 * replaying partial output (see the plan's Phase 5 decision gate).
 */
async function peekSessionExpiry(
	response: Response,
): Promise<{ expired: boolean; response: Response }> {
	const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
	// A streaming success is the common case: hand it back without reading a byte.
	if (contentType.includes("text/event-stream")) {
		return { expired: false, response };
	}
	// Non-stream response: a small error envelope. Buffer it whole and classify,
	// rebuilding the body so it stays readable downstream.
	const bodyText = await response.text();
	return {
		expired: isSessionExpiredBody(bodyText),
		response: new Response(bodyText, {
			status: response.status,
			statusText: response.statusText,
			headers: headersWithoutFraming(response.headers),
		}),
	};
}

/**
 * Wrap a fetch so every request authenticates with a Snowflake **session token**
 * (`Authorization: Snowflake Token="..."`), replacing any Bearer/x-api-key
 * header the SDK set.
 *
 * When `refresh` is supplied, the wrapper also handles session-token expiry: a
 * pre-stream `390112` triggers a single transparent reauthenticate-and-retry of
 * *this client's* connection. Without `refresh` it behaves as a plain auth
 * rewrite (there is nothing to retry with).
 */
function createSnowflakeSessionFetch(
	sessionToken: string,
	delegate: FetchFn,
	refresh?: SnowflakeSessionRefresh,
): FetchFn {
	let currentToken = sessionToken;
	const withSessionAuth = (init?: RequestInit): RequestInit => {
		const headers = new Headers(init?.headers);
		headers.delete("x-api-key");
		headers.set("Authorization", `Snowflake Token="${currentToken}"`);
		return { ...init, headers };
	};

	return async (url, init) => {
		const response = await delegate(url, withSessionAuth(init));
		if (!refresh) {
			return response;
		}

		const peeked = await peekSessionExpiry(response);
		if (!peeked.expired) {
			return peeked.response;
		}

		// Pre-stream 390112: reauthenticate this connection and retry exactly once.
		// If reauth fails, surface the original error body to the caller.
		let freshToken: string;
		try {
			freshToken = await refresh.reauthenticate(refresh.connectionIdentity);
		} catch {
			return peeked.response;
		}
		currentToken = freshToken;
		return delegate(url, withSessionAuth(init));
	};
}

export class SnowflakeClient implements ModelClient {
	private readonly token: string;
	private readonly baseUrl: string;
	private readonly authScheme: SnowflakeAuthScheme;
	private readonly customHeaders?: Record<string, string>;
	private readonly sessionRefresh?: SnowflakeSessionRefresh;
	private readonly logger?: Logger;

	constructor(
		token: string,
		baseUrl: string,
		authScheme: SnowflakeAuthScheme,
		customHeaders?: Record<string, string>,
		sessionRefresh?: SnowflakeSessionRefresh,
		logger?: Logger,
	) {
		this.token = token;
		this.baseUrl = baseUrl;
		this.authScheme = authScheme;
		this.customHeaders = customHeaders;
		this.sessionRefresh = sessionRefresh;
		this.logger = logger;
	}

	/** True when the token is a session token needing the `Snowflake Token=` scheme. */
	private get isSessionAuth(): boolean {
		return this.authScheme === "session";
	}

	async chat(params: ModelClientChatParams): Promise<AsyncIterable<LMStreamPart>> {
		const effectiveBaseUrl = params.baseUrl ?? this.baseUrl;

		// When an explicit protocol is provided, normalize and route on it.
		if (params.protocol) {
			const normalizedProtocol = normalizeProtocol(params.protocol);
			switch (normalizedProtocol) {
				case "anthropic-messages":
					return this.chatAnthropic(params, effectiveBaseUrl);
				case "openai-chat":
					return this.chatOpenAI(params, effectiveBaseUrl);
				default:
					throw new Error(`Unsupported protocol for Snowflake: ${normalizedProtocol}`);
			}
		}

		// Fallback: infer protocol from model ID. Claude models use Anthropic
		// Messages API, all others use OpenAI Chat Completions API.
		if (isClaudeModel(params.model)) {
			return this.chatAnthropic(params, effectiveBaseUrl);
		}
		return this.chatOpenAI(params, effectiveBaseUrl);
	}

	/**
	 * Anthropic Messages API path for Claude models.
	 * Uses `authToken` to send `Authorization: Bearer` (not `x-api-key`).
	 */
	private async chatAnthropic(
		params: ModelClientChatParams,
		baseUrl: string,
	): Promise<AsyncIterable<LMStreamPart>> {
		const headers = safeSdkCustomHeaders(this.customHeaders);
		const provider = this.isSessionAuth
			? createAnthropic({
					// Auth is applied by the session fetch wrapper; this placeholder key
					// just satisfies the SDK (its x-api-key header is stripped there).
					apiKey: "session-auth",
					baseURL: baseUrl,
					fetch: createSnowflakeSessionFetch(this.token, globalThis.fetch, this.sessionRefresh),
					...(headers && { headers }),
				})
			: createAnthropic({
					authToken: this.token,
					baseURL: baseUrl,
					...(headers && { headers }),
				});
		const model = provider(params.model);

		const { abortController, cleanup } = createAbortControllerFromToken(params.cancellationToken);

		const useThinking = isThinkingEnabled(params.thinkingEffort);
		// Some Claude models reject the `eager_input_streaming` field on Snowflake
		// Cortex; opt those out (see rejectsEagerInputStreaming). Others accept it.
		const disableEagerToolStreaming = rejectsEagerInputStreaming(params.model);
		const providerOptions =
			useThinking || disableEagerToolStreaming
				? {
						anthropic: {
							...(disableEagerToolStreaming ? { toolStreaming: false } : {}),
							...(useThinking
								? {
										// `display: "summarized"` is required to receive thinking summary text.
										// Opus 4.7+/Fable 5 default to `"omitted"`, which streams thinking blocks
										// with only a signature and no text — so the UI shows no <thinking>.
										thinking: { type: "adaptive", display: "summarized" },
										effort: params.thinkingEffort,
									}
								: {}),
						},
					}
				: undefined;

		const result = streamTextAnthropicWire(
			{
				allowSystemInMessages: params.allowSystemInMessages,
				model,
				messages: params.messages,
				system: params.systemPrompt,
				maxOutputTokens: params.maxOutputTokens,
				tools: params.tools,
				toolChoice: params.tools ? "auto" : undefined,
				abortSignal: abortController.signal,
				providerOptions,
				onStepFinish: createStepLogger(params.stepLoggers || [], "snowflake-cortex", params.model),
			},
			this.logger,
		);

		return convertAiSdkStreamToPlatform(result.fullStream, cleanup);
	}

	/**
	 * OpenAI Chat Completions API path for non-Claude models.
	 * Uses the shared compat fetch wrapper for streaming response fixes.
	 */
	private async chatOpenAI(
		params: ModelClientChatParams,
		baseUrl: string,
	): Promise<AsyncIterable<LMStreamPart>> {
		// The compat fetch applies OpenAI-spec fix-ups. For session auth we keep a
		// non-empty apiKey so it does NOT strip the Authorization header, and wrap
		// it so the outer fetch installs the `Snowflake Token=` header last.
		const compatFetch = this.isSessionAuth
			? createOpenAICompatibleFetch("Snowflake", "session-auth", this.customHeaders)
			: createOpenAICompatibleFetch("Snowflake", this.token, this.customHeaders);
		const provider = createOpenAI({
			apiKey: this.token || "sk-placeholder",
			baseURL: baseUrl,
			fetch: this.isSessionAuth
				? createSnowflakeSessionFetch(this.token, compatFetch, this.sessionRefresh)
				: compatFetch,
		});
		const model = provider.chat(params.model);

		const { abortController, cleanup } = createAbortControllerFromToken(params.cancellationToken);

		const result = streamText({
			allowSystemInMessages: params.allowSystemInMessages,
			model,
			messages: params.messages,
			system: params.systemPrompt,
			maxOutputTokens: params.maxOutputTokens,
			tools: params.tools,
			toolChoice: params.tools ? "auto" : undefined,
			abortSignal: abortController.signal,
			...(isThinkingEnabled(params.thinkingEffort) && {
				providerOptions: {
					openai: {
						store: false,
						reasoningEffort: params.thinkingEffort,
						reasoningSummary: "detailed",
					},
				},
			}),
			onStepFinish: createStepLogger(params.stepLoggers || [], "snowflake-cortex", params.model),
		});

		return convertAiSdkStreamToPlatform(result.fullStream, cleanup);
	}
}
