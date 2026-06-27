/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * ModelClient interface and shared chat params type.
 */

import type { ModelMessage } from "ai";

import type { StepLogger } from "../StepLogger";
import type { AiToolWithJsonSchema, CancellationToken, LMStreamPart, Protocol } from "../types";

/**
 * Parameters for a chat request. Shared across all ModelClient implementations
 * so the contract is defined in one place.
 */
export interface ModelClientChatParams {
	/** The model ID from ModelInfo (provider-specific, exact string sent to API). */
	model: string;
	/** Chat messages in AI SDK format. */
	messages: ModelMessage[];
	/** System prompt. */
	systemPrompt?: string;
	/** Maximum tokens to generate. */
	maxOutputTokens?: number;
	/** Available tools (if supported). */
	tools?: Record<string, AiToolWithJsonSchema>;
	/** Cancellation token. */
	cancellationToken: CancellationToken;
	/** Thinking/reasoning effort level. */
	thinkingEffort?: string;
	/** Context length hint for the model (e.g., Ollama num_ctx). From ModelInfo.maxContextLength. */
	contextLength?: number;
	/** Whether provider-side web search should be enabled for this request. */
	webSearchEnabled?: boolean;
	/** Whether the model requires vLLM-style `chat_template_kwargs` to enable thinking. */
	requiresChatTemplateKwargs?: boolean;

	// Posit Assistant-specific parameters — not part of the generic
	// provider contract; may be removed when this package is extracted.
	metadata?: {
		sessionId?: string;
	};
	stepLoggers?: StepLogger[];

	// --- Per-request routing overrides (Phase 4) ---

	/**
	 * Resolved wire protocol for this request. When set, multi-protocol clients
	 * route on this instead of inferring from the model ID. Single-protocol
	 * clients may ignore it or validate it matches their expected protocol.
	 *
	 * Callers should pass the canonical `Protocol` value (e.g. `"anthropic-messages"`).
	 * Clients normalize legacy values via {@link normalizeProtocol} internally.
	 */
	protocol?: Protocol;

	/**
	 * Resolved base URL for this request. When set, overrides the client's
	 * constructor-time base URL. Used for per-model endpoint overrides from
	 * the provider config.
	 */
	baseUrl?: string;
}

/**
 * Generic model client interface
 * Provider clients must implement this interface
 */
export interface ModelClient {
	/**
	 * Send a chat request and stream the response
	 *
	 * @returns Async iterable of stream parts
	 */
	chat(params: ModelClientChatParams): Promise<AsyncIterable<LMStreamPart>>;
}
