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
import type { LMStreamPart } from "../types";
import { normalizeProtocol } from "../types";
import { isClaudeModel, isThinkingEnabled } from "../utils";
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

/**
 * How many bytes of the response body to buffer while deciding whether it is a
 * pre-stream `390112` error. The error envelope is a small complete JSON object,
 * so a modest window catches it even when the transport splits it across chunks
 * (e.g. `{"code":"390` / `112"}`) — while staying far below a real model stream,
 * which blows past this within its first content chunk. Kept small so ruling
 * expiry *out* on a success stream adds only trivial first-byte latency.
 */
const PRESTREAM_SCAN_LIMIT = 1024;

/** Copy headers, dropping framing headers invalidated by rebuilding the body. */
function headersWithoutFraming(headers: Headers): Headers {
	const copy = new Headers(headers);
	copy.delete("content-length");
	copy.delete("content-encoding");
	return copy;
}

/**
 * Inspect a Cortex response for a **pre-stream** `390112` (expired session)
 * without disturbing the success path. Buffers the leading bytes of the body
 * (up to {@link PRESTREAM_SCAN_LIMIT}) until it can rule expiry in or out — so a
 * `390112` envelope split across transport chunks is still detected, not passed
 * to the SDK as a bogus success. If not an expiry, returns a response whose body
 * replays the buffered bytes followed by the rest of the stream, so streaming is
 * byte-for-byte untouched. If it is, the small error body is fully buffered so
 * it can be re-surfaced when reauth fails.
 *
 * The pre-stream assumption (docs: "the operation is not performed") means the
 * whole 390112 body arrives before any model output. A `390112` that instead
 * appeared mid-SSE after emitted output would not be caught here — by policy
 * that case surfaces as a retryable failure rather than replaying partial output
 * (see the plan's Phase 5 decision gate).
 */
async function peekSessionExpiry(
	response: Response,
): Promise<{ expired: boolean; response: Response }> {
	if (!response.body) {
		return { expired: false, response };
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	// Keep raw chunks for a lossless replay; decode a parallel text view (with a
	// streaming decoder, so a multi-byte char split across chunks is handled) only
	// to scan for the error code.
	const buffered: Uint8Array[] = [];
	let scanned = "";
	let bufferedBytes = 0;
	let streamDone = false;

	// Buffer until the error code is found, the scan window fills (ruling expiry
	// out — this is a real stream), or the body ends.
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) {
			streamDone = true;
			break;
		}
		buffered.push(chunk.value);
		bufferedBytes += chunk.value.byteLength;
		scanned += decoder.decode(chunk.value, { stream: true });

		if (isSessionExpiredBody(scanned)) {
			// Pre-stream error: drain the (small) remainder so the original error can
			// be rebuilt and surfaced if reauthentication fails.
			let rest = "";
			for (;;) {
				const tail = await reader.read();
				if (tail.done) break;
				rest += decoder.decode(tail.value, { stream: true });
			}
			const errorBody = scanned + rest + decoder.decode();
			return {
				expired: true,
				response: new Response(errorBody, {
					status: response.status,
					statusText: response.statusText,
					headers: headersWithoutFraming(response.headers),
				}),
			};
		}

		if (bufferedBytes >= PRESTREAM_SCAN_LIMIT) {
			break;
		}
	}

	// Not an expiry error — replay the buffered bytes, then the rest of the stream.
	const passthrough = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of buffered) {
				controller.enqueue(chunk);
			}
			if (streamDone) controller.close();
		},
		async pull(controller) {
			const chunk = await reader.read();
			if (chunk.done) {
				controller.close();
				return;
			}
			controller.enqueue(chunk.value);
		},
		cancel(reason) {
			void reader.cancel(reason);
		},
	});
	return {
		expired: false,
		response: new Response(passthrough, {
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

	constructor(
		token: string,
		baseUrl: string,
		authScheme: SnowflakeAuthScheme,
		customHeaders?: Record<string, string>,
		sessionRefresh?: SnowflakeSessionRefresh,
	) {
		this.token = token;
		this.baseUrl = baseUrl;
		this.authScheme = authScheme;
		this.customHeaders = customHeaders;
		this.sessionRefresh = sessionRefresh;
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
		// Haiku 4.5 rejects the `eager_input_streaming` field that @ai-sdk/anthropic
		// adds to tool specs by default while streaming, returning HTTP 400
		// (tools.0.custom.eager_input_streaming: Extra inputs are not permitted).
		// Scope the opt-out to Haiku 4.5, matching the Bedrock fix (posit-dev/ai-provider-bridge#14).
		const disableEagerToolStreaming = params.model.includes("claude-haiku-4-5");
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

		const result = streamText({
			model,
			messages: params.messages,
			system: params.systemPrompt,
			maxOutputTokens: params.maxOutputTokens,
			tools: params.tools,
			toolChoice: params.tools ? "auto" : undefined,
			abortSignal: abortController.signal,
			providerOptions,
			onStepFinish: createStepLogger(params.stepLoggers || [], "snowflake-cortex", params.model),
		});

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
