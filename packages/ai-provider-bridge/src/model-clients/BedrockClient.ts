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
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { streamText } from "ai";

import type { LMStreamPart, Protocol } from "../types";
import { normalizeProtocol } from "../types";
import { isThinkingEnabled } from "../utils";
import {
	convertAiSdkStreamToPlatform,
	createAbortControllerFromToken,
	createStepLogger,
} from "./ai-sdk-helpers";
import type { ModelClient, ModelClientChatParams } from "./ModelClient";

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
			normalizedProtocol !== "bedrock-converse"
		) {
			throw new Error(`Unsupported protocol for Bedrock: ${normalizedProtocol}`);
		}

		const model = this.createModel(params.model, normalizedProtocol);

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
		const providerOptions =
			isThinkingEnabled(params.thinkingEffort) && isAnthropic
				? {
						anthropic: {
							// `display: "summarized"` is required to receive thinking summary text.
							// Opus 4.7+/Fable 5 default to `"omitted"`, which streams thinking blocks
							// with only a signature and no text — so the UI shows no <thinking>.
							thinking: { type: "adaptive", display: "summarized" },
							effort: params.thinkingEffort,
						},
					}
				: undefined;

		// Stream the response
		const result = streamText({
			model,
			messages: params.messages,
			system: params.systemPrompt,
			maxOutputTokens: params.maxOutputTokens || 4096,
			tools: params.tools,
			toolChoice: params.tools ? "auto" : undefined,
			abortSignal: abortController.signal,
			providerOptions,
			// Capture raw JSON on each step finish
			onStepFinish: createStepLogger(params.stepLoggers || [], "bedrock", params.model),
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
	 * - All other models use `createAmazonBedrock` (Converse API).
	 *
	 * When an explicit `protocol` is provided, it takes precedence over the
	 * model-ID heuristic.
	 */
	private createModel(modelId: string, protocol?: Protocol): LanguageModelV3 {
		const useManualKeys = this.config.accessKeyId && this.config.secretAccessKey;

		const credentialConfig = useManualKeys
			? {
					accessKeyId: this.config.accessKeyId!,
					secretAccessKey: this.config.secretAccessKey!,
					...(this.config.sessionToken && {
						sessionToken: this.config.sessionToken,
					}),
				}
			: {
					credentialProvider: fromNodeProviderChain({
						profile: this.config.profile,
					}),
				};

		const useAnthropicApi = protocol
			? protocol === "anthropic-messages"
			: isAnthropicModel(modelId);

		if (useAnthropicApi) {
			return createBedrockAnthropic({
				region: this.config.region,
				...credentialConfig,
			})(modelId);
		}

		return createAmazonBedrock({
			region: this.config.region,
			...credentialConfig,
		})(modelId);
	}
}
