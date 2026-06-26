/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * VS Code Language Model Client
 *
 * ModelClient implementation wrapping vscode.lm.sendRequest().
 * Accepts a vscode.LanguageModelChat instance at construction time,
 * which carries vendor information for provider-specific quirks.
 */

import type * as ai from "ai";
import * as vscode from "vscode";

import type { ModelClient } from "../model-clients/ModelClient";
import {
	hasImagesInToolResults,
	transformToolResultImagesForCompletions,
} from "../tool-result-images";
import type { AiToolWithJsonSchema, CancellationToken, LMStreamPart, Logger } from "../types";
import { fromAiMessages2 } from "./message-formats";
import { ensureUint8Array } from "./utils";

/**
 * Providers that don't support images in tool results.
 * These use the Chat Completions API which only supports images in user messages.
 */
const PROVIDERS_WITHOUT_TOOL_RESULT_IMAGES = ["snowflake-cortex"];

export interface VscodeLmClientOptions {
	/**
	 * Whether the target VS Code LM host supports images in tool results.
	 * When false, images in tool results are replaced with placeholder text
	 * in the fromAiMessages2 conversion. Default: true.
	 */
	supportsToolResultImages?: boolean;
}

/**
 * ModelClient implementation that wraps a VS Code Language Model.
 *
 * Usage:
 * ```typescript
 * const models = await vscode.lm.selectChatModels({ id: "some-model-id" });
 * const client = new VscodeLmClient(models[0], logger);
 * const stream = await client.chat({ model: "some-model-id", messages, cancellationToken });
 * ```
 */
export class VscodeLmClient implements ModelClient {
	private readonly supportsToolResultImages: boolean;

	constructor(
		private readonly model: vscode.LanguageModelChat,
		private readonly logger: Logger,
		options?: VscodeLmClientOptions,
	) {
		this.supportsToolResultImages = options?.supportsToolResultImages ?? true;
	}

	async chat(params: {
		model: string;
		messages: ai.ModelMessage[];
		systemPrompt?: string;
		maxOutputTokens?: number;
		tools?: Record<string, AiToolWithJsonSchema>;
		/** VS Code LM-specific: tool invocation mode. */
		toolMode?: "auto" | "required";
		cancellationToken: CancellationToken;
		metadata?: {
			sessionId?: string;
		};
	}): Promise<AsyncIterable<LMStreamPart>> {
		let messages = [...params.messages];

		// If messages array contained any system messages, extract the contents and remove them from
		// the array, because vscode.lm API doesn't support system parts in the message array; the
		// system prompt must be sent in as a separate parameter. Positron automatically adds
		// cache_control markers to the system prompt.
		let systemPrompt = params.systemPrompt;
		const systemPromptFromMessages = messages
			.filter((m) => m.role === "system")
			.map((m) => m.content)
			.join("\n");

		if (systemPromptFromMessages !== "") {
			if (systemPrompt) {
				this.logger.error(
					"VscodeLmClient.chat(): System prompt cannot be specified both in the messages array and as a separate systemPrompt parameter. Using the system prompt from messages array instead of from systemPrompt parameter.",
				);
			}
			systemPrompt = systemPromptFromMessages;
		}
		messages = messages.filter((m) => m.role !== "system");

		// Special case for Copilot provider: as of Positron 2025.10.0 build 73 it
		// does not support setting the system prompt via options.modelOptions, so
		// instead we'll prepend the system prompt as the first User message.
		if (this.model.vendor === "copilot") {
			messages.unshift({
				role: "user",
				content: [
					{
						type: "text",
						text: systemPrompt || "",
					},
				],
			});
		}

		// Transform tool result images for providers that don't support them natively.
		// This moves images from tool results to user messages for Chat Completions API compatibility.
		if (
			PROVIDERS_WITHOUT_TOOL_RESULT_IMAGES.includes(this.model.vendor) &&
			hasImagesInToolResults(messages)
		) {
			messages = structuredClone(transformToolResultImagesForCompletions(messages));
		}

		// Convert AI SDK messages to VS Code format
		// Preserve cache markers for LLM requests
		const vscodeMessages = fromAiMessages2(messages, {
			preserveCacheMarkers: true,
			supportsToolResultImages: this.supportsToolResultImages,
		});

		// Set up options
		const options: vscode.LanguageModelChatRequestOptions = {
			modelOptions: {
				system: systemPrompt,
				maxOutputTokens: params.maxOutputTokens,
				sessionId: params.metadata?.sessionId,
			},
		};

		// Add tool support
		if (params.tools && Object.keys(params.tools).length > 0) {
			options.tools = Object.entries(params.tools).map(([name, tool]) => ({
				name: name,
				description: tool.description || "",
				inputSchema: tool.inputSchema.jsonSchema,
			}));

			if (params.toolMode === "required") {
				options.toolMode = vscode.LanguageModelChatToolMode.Required;
			} else {
				options.toolMode = vscode.LanguageModelChatToolMode.Auto;
			}
		}

		// Send request
		const chatResponse = await this.model.sendRequest(
			vscodeMessages,
			options,
			params.cancellationToken,
		);

		// Convert response stream to platform-agnostic format
		// Note: chatResponse.stream is typed as AsyncIterable<unknown> in VS Code API
		return this.convertResponseStream(
			chatResponse.stream as AsyncIterable<
				| vscode.LanguageModelTextPart
				| vscode.LanguageModelToolCallPart
				| vscode.LanguageModelDataPart
			>,
		);
	}

	/**
	 * Convert VS Code response stream to platform-agnostic format
	 */
	private async *convertResponseStream(
		vscodeStream: AsyncIterable<
			vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart | vscode.LanguageModelDataPart
		>,
	): AsyncIterable<LMStreamPart> {
		for await (const part of vscodeStream) {
			if (part instanceof vscode.LanguageModelTextPart) {
				yield { type: "text-delta", id: "0", text: part.value };
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				yield {
					type: "tool-call",
					toolCallId: part.callId,
					toolName: part.name,
					input: part.input,
				};
			} else if (part instanceof vscode.LanguageModelDataPart) {
				try {
					// Look for special ending data part which includes token usage information
					if (part.mimeType === "text/x-json") {
						const data = ensureUint8Array(part.data, this.logger);

						// Decode the provided JSON payload
						const payload = JSON.parse(new TextDecoder().decode(data));
						if (
							"type" in payload &&
							payload.type === "usage" &&
							"data" in payload &&
							payload.data
						) {
							// At this point, the data should look like this.
							// Note that this differs from AI SDK v6 counts in an important way:
							// inputTokens here counts both the cached and uncached input tokens.
							// From the AI SDK, it includes _only_ the uncached input tokens; the
							// cached input tokens are not reported at all. The way to get the cached
							// input tokens is to look at the providerMetadata, which is just the
							// data forwarded directly from Anthropic.
							//
							// {
							//   "type": "usage",
							//   "data": {
							//     "inputTokens": 58,
							//     "outputTokens": 1,
							//     "cachedTokens": 30284,
							//     "providerMetadata": {
							//       "anthropic": {
							//         "input_tokens": 2,
							//         "cache_creation_input_tokens": 56,
							//         "cache_read_input_tokens": 30284,
							//         "cache_creation": {
							//           "ephemeral_5m_input_tokens": 56,
							//           "ephemeral_1h_input_tokens": 0
							//         },
							//         "output_tokens": 1,
							//         "service_tier": "standard"
							//       }
							//     }
							//   }
							// }
							const usagePayload = payload.data as TokenUsage;
							const usageData = {
								inputTokens: usagePayload.inputTokens,
								inputTokenDetails: {
									noCacheTokens: usagePayload.inputTokens,
									cacheReadTokens: usagePayload.cachedTokens,
									cacheWriteTokens: undefined,
								},
								outputTokens: usagePayload.outputTokens,
								outputTokenDetails: {
									textTokens: usagePayload.outputTokens,
									reasoningTokens: undefined,
								},
								totalTokens: usagePayload.inputTokens + usagePayload.outputTokens,
							};

							// Fixup the Positron provided `providerMetadata` so that it has the expected
							// `usage` property below the provider key. This should be fixed in Positron.
							const metadata = payload.data.providerMetadata as ai.ProviderMetadata | undefined;
							if (metadata) {
								for (const [key, value] of Object.entries(metadata)) {
									if (value && typeof value === "object" && !("usage" in value)) {
										metadata[key] = { usage: value };
									}
								}
							}

							yield {
								type: "finish-step",
								finishReason: "stop",
								rawFinishReason: "stop",
								usage: usageData,
								response: {
									id: "0",
									modelId: "",
									timestamp: new Date(),
								},
								providerMetadata: metadata,
							};
						}
					}
				} catch (e) {
					// Don't fail the entire request if something goes wrong.
					// Just log a warning and continue.
					this.logger.warn("Failed to parse usage data in LLM response stream", e);
				}
			}
		}
	}
}

// Type from Positron at:
// https://github.com/posit-dev/positron/blob/f7ff362c099f264d0a6c97f8c72a5eee883bb5b1/extensions/positron-assistant/src/tokens.ts
export type TokenUsage = {
	/** The number of input tokens, not including tokens read from cache. */
	inputTokens: number;
	/** The number of output tokens in responses. */
	outputTokens: number;
	/** The number of tokens that have been read from cache. */
	cachedTokens: number;
	/** Provider specific metadata with additional usage details. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	providerMetadata?: any;
};
