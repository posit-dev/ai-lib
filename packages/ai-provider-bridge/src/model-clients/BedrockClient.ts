/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Amazon Bedrock API Client
 *
 * Implements ModelClient interface for Amazon Bedrock models
 * Supports both AWS credential provider chain (SSO, profiles, env vars, IAM roles)
 * and manual AWS Access Keys
 */

import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createBedrockAnthropic } from "@ai-sdk/amazon-bedrock/anthropic";
import { createBedrockMantle } from "@ai-sdk/amazon-bedrock/mantle";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { streamText } from "ai";

import { createAwsCredentialProvider } from "../aws-credentials";
import { sanitizeToolCallIdsForAnthropic } from "../tool-call-ids";
import {
	hasImagesInToolResults,
	transformToolResultImagesForCompletions,
} from "../tool-result-images";
import type { LMStreamPart, Protocol } from "../types";
import { normalizeProtocol } from "../types";
import { isThinkingEnabled, rejectsEagerInputStreaming } from "../utils";
import {
	convertAiSdkStreamToPlatform,
	createAbortControllerFromToken,
	createStepLogger,
} from "./ai-sdk-helpers";
import type { ModelClient, ModelClientChatParams } from "./ModelClient";
import { prepareExplicitOpenAIRequest } from "./openai-prompt-caching";

const EXPLICIT_PROMPT_CACHE_OPTIONS: { mode: "explicit"; ttl: "30m" } = {
	mode: "explicit",
	ttl: "30m",
};

/**
 * Check if a Bedrock model ID refers to an Anthropic model.
 * Matches standard IDs (`anthropic.claude-*`, `us.anthropic.claude-*`)
 * and ARN-style IDs (`arn:aws:bedrock:…/anthropic.claude-*`).
 */
export function isAnthropicModel(modelId: string): boolean {
	return /(?:^|[./])anthropic\./.test(modelId);
}

export interface BedrockClientConfig {
	region: string;
	profile?: string;
	accessKeyId?: string;
	secretAccessKey?: string;
	sessionToken?: string;
}

export class BedrockClient implements ModelClient {
	private readonly config: BedrockClientConfig;

	constructor(config: BedrockClientConfig) {
		this.config = config;
	}

	async chat(params: ModelClientChatParams): Promise<AsyncIterable<LMStreamPart>> {
		const normalizedProtocol = normalizeProtocol(params.protocol);

		if (
			normalizedProtocol &&
			normalizedProtocol !== "anthropic-messages" &&
			normalizedProtocol !== "bedrock-converse" &&
			normalizedProtocol !== "openai-chat" &&
			normalizedProtocol !== "openai-responses"
		) {
			throw new Error(`Unsupported protocol for Bedrock: ${normalizedProtocol}`);
		}

		const model = this.createModel(params.model, normalizedProtocol, params.baseUrl);

		// Create abort controller with cleanup to prevent EventEmitter memory leaks
		const { abortController, cleanup } = createAbortControllerFromToken(params.cancellationToken);

		// Determine whether to use Anthropic-style provider options.
		// Respect explicit protocol when set; otherwise fall back to model-ID heuristic.
		const isAnthropic = normalizedProtocol
			? normalizedProtocol === "anthropic-messages"
			: isAnthropicModel(params.model);

		// For Anthropic models on Bedrock, pass thinking config via providerOptions.
		// The createBedrockAnthropic provider uses AnthropicMessagesLanguageModel internally,
		// so it accepts the same `anthropic` provider options as the direct Anthropic provider.
		const useThinking = isThinkingEnabled(params.thinkingEffort) && isAnthropic;
		// Some Claude models reject the `eager_input_streaming` field on Bedrock; opt
		// those out (see rejectsEagerInputStreaming). Others accept it, so leave them on.
		const disableEagerToolStreaming = rejectsEagerInputStreaming(params.model);
		const anthropicProviderOptions =
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

		const isMantleChat = normalizedProtocol === "openai-chat";
		const isMantleResponses = normalizedProtocol === "openai-responses";
		// Transport veto: Mantle serializes OpenAI explicit-cache fields only on
		// its Responses route, so the host's opt-in is honored there alone.
		const usesExplicitPromptCaching =
			params.usesExplicitPromptCaching === true && isMantleResponses;
		const mantleReasoningEffort =
			isMantleResponses && params.thinkingEffort === "off"
				? "none"
				: isThinkingEnabled(params.thinkingEffort)
					? params.thinkingEffort
					: undefined;
		let messagesToSend = params.messages;
		if (
			hasImagesInToolResults(params.messages) &&
			(isMantleChat || (isMantleResponses && !params.supportsToolResultImages))
		) {
			messagesToSend = transformToolResultImagesForCompletions(
				params.messages,
				params.supportsImages ?? false,
			);
		}
		// `usesExplicitPromptCaching` already folds in the Chat-route veto, so the
		// seam strips markers on that route too — Mantle would otherwise serialize
		// them.
		const prepared = prepareExplicitOpenAIRequest(messagesToSend, {
			enabled: usesExplicitPromptCaching,
			apiMode: "responses",
			sessionId: params.metadata?.sessionId,
		});
		messagesToSend = prepared.messages;
		const promptCacheKey = prepared.promptCacheKey;

		const providerOptions = isMantleResponses
			? {
					openai: {
						// Mantle Responses retains content by default. Keep requests
						// stateless; forceReasoning also makes the SDK round-trip
						// encrypted reasoning content when store is false.
						store: false,
						forceReasoning: true,
						reasoningEffort: mantleReasoningEffort,
						reasoningSummary: "detailed",
						...(usesExplicitPromptCaching
							? {
									promptCacheOptions: EXPLICIT_PROMPT_CACHE_OPTIONS,
									...(promptCacheKey !== undefined ? { promptCacheKey } : {}),
								}
							: {}),
					},
				}
			: isMantleChat && isThinkingEnabled(params.thinkingEffort)
				? {
						openai: {
							reasoningEffort: params.thinkingEffort,
						},
					}
				: anthropicProviderOptions;

		// The Anthropic Messages wire validates tool_use.id against
		// `^[a-zA-Z0-9_-]+$`; sanitize outbound IDs on that route only.
		if (isAnthropic) {
			messagesToSend = sanitizeToolCallIdsForAnthropic(messagesToSend);
		}

		// Stream the response
		const result = streamText({
			allowSystemInMessages: params.allowSystemInMessages,
			model,
			messages: messagesToSend,
			system: params.systemPrompt,
			// GPT-5.x has no published family-wide ceiling. Do not impose the
			// historic Bedrock fallback on Mantle Responses; all existing routes
			// retain it, and gpt-oss discovery supplies 16,384 explicitly.
			maxOutputTokens: isMantleResponses ? params.maxOutputTokens : params.maxOutputTokens || 4096,
			tools: params.tools,
			toolChoice: params.tools ? "auto" : undefined,
			abortSignal: abortController.signal,
			providerOptions,
			// Capture raw JSON on each step finish
			onStepFinish: createStepLogger(
				params.stepLoggers || [],
				isMantleChat || isMantleResponses ? "bedrock-mantle" : "bedrock",
				params.model,
			),
		});

		// Convert to platform-agnostic format with cleanup on completion
		return convertAiSdkStreamToPlatform(result.fullStream, cleanup);
	}

	/**
	 * Create the appropriate AI SDK model instance for the given model ID.
	 *
	 * - Anthropic models use `createBedrockAnthropic` (native Anthropic InvokeModel API
	 *   through Bedrock) for full feature parity including prompt caching via
	 *   `providerOptions.anthropic.cacheControl`.
	 * - OpenAI protocols use Bedrock Mantle. Only these routes honor `baseUrl`.
	 * - All other models use `createAmazonBedrock` (Converse API).
	 *
	 * When an explicit `protocol` is provided, it takes precedence over the
	 * model-ID heuristic.
	 */
	private createModel(modelId: string, protocol?: Protocol, baseUrl?: string): LanguageModelV3 {
		const credentialProvider = createAwsCredentialProvider(this.config);

		if (protocol === "openai-chat" || protocol === "openai-responses") {
			const mantle = createBedrockMantle({
				region: this.config.region,
				baseURL: baseUrl,
				credentialProvider,
				// Enforce the AWS-credentials-only contract. Without this explicit
				// opt-out, a stale AWS_BEARER_TOKEN_BEDROCK overrides SigV4.
				apiKey: "",
			});
			return protocol === "openai-chat" ? mantle.chat(modelId) : mantle.responses(modelId);
		}

		const useAnthropicApi = protocol
			? protocol === "anthropic-messages"
			: isAnthropicModel(modelId);

		if (useAnthropicApi) {
			return createBedrockAnthropic({
				region: this.config.region,
				credentialProvider,
			})(modelId);
		}

		return createAmazonBedrock({
			region: this.config.region,
			credentialProvider,
		})(modelId);
	}
}
