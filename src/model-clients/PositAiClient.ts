/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Posit AI Client
 *
 * Multi-protocol client that supports both Anthropic and OpenAI API formats
 * with OAuth Bearer token authentication. Routes internally based on model ID:
 * Claude models use Anthropic Messages API, all others use OpenAI Chat Completions.
 *
 * Uses Vercel AI SDK with custom fetch wrapper to replace x-api-key header
 * with Authorization: Bearer header required by Posit AI.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ModelMessage } from "ai";
import { streamText } from "ai";

import type { StepLogger } from "../StepLogger";
import {
	hasImagesInToolResults,
	transformToolResultImagesForCompletions,
} from "../tool-result-images";
import type { AiToolWithJsonSchema, CancellationToken, LMStreamPart, Logger } from "../types";
import { isAgreementRequiredBody, isClaudeModel, isThinkingEnabled, joinPath } from "../utils";
import {
	convertAiSdkStreamToPlatform,
	createAbortControllerFromToken,
	createStepLogger,
} from "./ai-sdk-helpers";
import type { ModelClient } from "./ModelClient";

/**
 * Custom fetch wrapper that replaces x-api-key header with Authorization: Bearer
 * required by Posit AI's OAuth authentication
 */
function createAuthenticatedFetch(
	accessToken: string,
	logger: Logger,
	customHeaders?: Record<string, string>,
	onCreditsDepleted?: () => void,
	onAgreementRequired?: () => void,
): typeof globalThis.fetch {
	return async (url: string | URL | Request, options?: RequestInit) => {
		const headers = new Headers(options?.headers);

		// Remove x-api-key header that AI SDK adds by default
		headers.delete("x-api-key");

		// Add OAuth Bearer token
		headers.set("Authorization", `Bearer ${accessToken}`);

		// Add custom headers (User-Agent, Session-Id, etc.)
		if (customHeaders) {
			for (const [key, value] of Object.entries(customHeaders)) {
				if (value) {
					headers.set(key, value);
				}
			}
		}

		logger.trace("[PositAiClient] Request to:", url.toString());
		logger.trace("[PositAiClient] Method:", options?.method || "GET");

		// Log all headers
		const headerObj: Record<string, string> = {};
		headers.forEach((value, key) => {
			// Truncate Authorization header for security
			if (key.toLowerCase() === "authorization") {
				headerObj[key] = value.substring(0, 20) + "...[truncated]";
			} else {
				headerObj[key] = value;
			}
		});
		logger.trace("[PositAiClient] Headers:", JSON.stringify(headerObj, null, 2));
		logger.trace("[PositAiClient] Body:", options?.body);

		const response = await globalThis.fetch(url, {
			...options,
			headers,
		});

		// Log response headers
		const responseHeaderObj: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			responseHeaderObj[key] = value;
		});
		logger.trace("[PositAiClient] Response status:", response.status);
		logger.trace("[PositAiClient] Response headers:", JSON.stringify(responseHeaderObj, null, 2));

		// Detect credits depleted (402) response from gateway
		if (response.status === 402 && onCreditsDepleted) {
			onCreditsDepleted();
		}

		// Detect agreement not signed (403) response from gateway
		if (response.status === 403 && onAgreementRequired) {
			try {
				const body = await response.clone().text();
				if (isAgreementRequiredBody(body)) {
					onAgreementRequired();
				}
			} catch {
				// Can't read body — don't trigger agreement notification
			}
		}

		return response;
	};
}

/** Maximum number of web searches per request */
const WEB_SEARCH_MAX_USES = 5;

export class PositAiClient implements ModelClient {
	private readonly accessToken: string;
	private readonly baseURL: string;
	private readonly userAgent: string;
	private readonly logger: Logger;

	constructor(accessToken: string, baseURL: string, userAgent: string, logger: Logger) {
		this.accessToken = accessToken;
		this.baseURL = baseURL;
		this.userAgent = userAgent;
		this.logger = logger;
	}

	async chat(params: {
		model: string;
		messages: ModelMessage[];
		systemPrompt?: string;
		maxOutputTokens?: number;
		tools?: Record<string, AiToolWithJsonSchema>;
		cancellationToken: CancellationToken;
		thinkingEffort?: string;
		metadata?: {
			sessionId?: string;
			conversationId?: string;
		};
		stepLoggers?: StepLogger[];
		webSearchEnabled?: boolean;
		requiresChatTemplateKwargs?: boolean;
	}): Promise<AsyncIterable<LMStreamPart>> {
		// Infer protocol from model ID: Claude models use Anthropic Messages API,
		// all others use OpenAI Chat Completions API.
		const protocol = isClaudeModel(params.model) ? "anthropic" : "openai";

		// Build headers combining static User-Agent and per-request Session-Id
		const headers: Record<string, string> = {
			"User-Agent": this.userAgent,
		};
		if (params.metadata?.sessionId) {
			headers["Session-Id"] = params.metadata.sessionId;
		}

		// Notify step loggers on 402 (credits depleted) so LicenseHeaderMonitor
		// sends the depleted notification before the streaming error surfaces.
		const onCreditsDepleted = () => {
			for (const logger of params.stepLoggers || []) {
				try {
					logger.reportCreditsDepleted?.();
				} catch {
					// Depletion reporting must not interfere with request error handling
				}
			}
		};

		// Notify step loggers on 403 (agreement not signed) so LicenseHeaderMonitor
		// sends the setup-required notification before the streaming error surfaces.
		const onAgreementRequired = () => {
			for (const logger of params.stepLoggers || []) {
				try {
					logger.reportAgreementRequired?.();
				} catch {
					// Agreement reporting must not interfere with request error handling
				}
			}
		};

		// Create custom fetch with OAuth Bearer authentication and headers
		const authenticatedFetch = createAuthenticatedFetch(
			this.accessToken,
			this.logger,
			headers,
			onCreditsDepleted,
			onAgreementRequired,
		);

		// Create abort controller with cleanup to prevent EventEmitter memory leaks
		const { abortController, cleanup } = createAbortControllerFromToken(params.cancellationToken);

		if (protocol === "anthropic") {
			const providerOptions = isThinkingEnabled(params.thinkingEffort)
				? {
						anthropic: {
							thinking: { type: "adaptive" as const },
							effort: params.thinkingEffort,
						},
					}
				: undefined;

			// Use Anthropic provider with OAuth authentication
			const provider = createAnthropic({
				apiKey: this.accessToken, // Required for SDK initialization, not used in header
				baseURL: joinPath(this.baseURL, "/anthropic/v1"),
				fetch: authenticatedFetch,
			});
			const model = provider(params.model);

			// Build tools - add web search if explicitly enabled per-request
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			let tools: Record<string, any> | undefined = params.tools;
			if (params.webSearchEnabled) {
				const webSearchTool = provider.tools.webSearch_20250305({
					maxUses: WEB_SEARCH_MAX_USES,
				});
				tools = { ...tools, web_search: webSearchTool };
			}

			const result = streamText({
				model,
				messages: params.messages,
				system: params.systemPrompt,
				maxOutputTokens: params.maxOutputTokens,
				tools,
				toolChoice: tools ? "auto" : undefined,
				abortSignal: abortController.signal,
				providerOptions,
				// Capture raw JSON on each step finish
				onStepFinish: createStepLogger(params.stepLoggers || [], "positai", params.model),
			});

			return convertAiSdkStreamToPlatform(result.fullStream, cleanup);
		} else if (protocol === "openai") {
			const useChatTemplateKwargs =
				params.requiresChatTemplateKwargs && isThinkingEnabled(params.thinkingEffort);

			// Use OpenAI-compatible provider with OAuth authentication
			const provider = createOpenAICompatible({
				name: "positai",
				baseURL: joinPath(this.baseURL, "/openai/v1"),
				fetch: authenticatedFetch,
				...(useChatTemplateKwargs && {
					transformRequestBody: (body: Record<string, unknown>) => ({
						...body,
						chat_template_kwargs: { enable_thinking: true },
					}),
				}),
			});
			const model = provider.chatModel(params.model);

			// Transform tool result images (OpenAI protocol uses completions API which doesn't support
			// images in tool results)
			let messagesToSend = params.messages;
			if (hasImagesInToolResults(params.messages)) {
				messagesToSend = transformToolResultImagesForCompletions(params.messages);
			}

			const result = streamText({
				model,
				messages: messagesToSend,
				system: params.systemPrompt,
				maxOutputTokens: params.maxOutputTokens,
				tools: params.tools,
				toolChoice: params.tools ? "auto" : undefined,
				abortSignal: abortController.signal,
				// Capture raw JSON on each step finish
				onStepFinish: createStepLogger(params.stepLoggers || [], "positai", params.model),
			});

			return convertAiSdkStreamToPlatform(result.fullStream, cleanup);
		} else {
			cleanup();
			throw new Error(`Unsupported protocol: ${protocol}`);
		}
	}
}
