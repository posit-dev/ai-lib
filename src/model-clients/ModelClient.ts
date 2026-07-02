/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * ModelClient interface
 */

import type { ModelMessage } from "ai";

import type { StepLogger } from "../StepLogger";
import type { AiToolWithJsonSchema, CancellationToken, LMStreamPart } from "../types";

/**
 * Generic model client interface
 * Provider clients must implement this interface
 */
export interface ModelClient {
	/**
	 * Send a chat request and stream the response
	 *
	 * @param params.model - The model ID from ModelInfo (provider-specific)
	 * @param params.messages - Chat messages in AI SDK format
	 * @param params.systemPrompt - System prompt
	 * @param params.maxOutputTokens - Maximum tokens to generate
	 * @param params.tools - Available tools (if supported)
	 * @param params.cancellationToken - Cancellation token
	 * @param params.thinkingEffort - Thinking/reasoning effort level
	 * @returns Async iterable of stream parts
	 */
	chat(params: {
		model: string;
		messages: ModelMessage[];
		systemPrompt?: string;
		maxOutputTokens?: number;
		tools?: Record<string, AiToolWithJsonSchema>;
		cancellationToken: CancellationToken;
		thinkingEffort?: string;
		/** Context length hint for the model (e.g., Ollama num_ctx). From ModelInfo.maxContextLength. */
		contextLength?: number;
		/** Whether provider-side web search should be enabled for this request. */
		webSearchEnabled?: boolean;
		/** Whether the model requires vLLM-style `chat_template_kwargs` to enable thinking. */
		requiresChatTemplateKwargs?: boolean;
		/**
		 * Whether the target model accepts image input at all. Used to decide how
		 * tool-result images are transformed for APIs that can't embed images in
		 * tool results: when `true`, images are moved to a follow-up user message;
		 * when `false`, images are stripped with an explanatory note.
		 */
		supportsImages?: boolean;

		// Posit Assistant-specific parameters — not part of the generic
		// provider contract; may be removed when this package is extracted.
		metadata?: {
			sessionId?: string;
		};
		stepLoggers?: StepLogger[];
	}): Promise<AsyncIterable<LMStreamPart>>;
}
