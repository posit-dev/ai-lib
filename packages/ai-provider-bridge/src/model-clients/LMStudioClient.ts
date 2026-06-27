/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * LM Studio API Client
 *
 * LM Studio provides OpenAI-compatible API at /v1/chat/completions,
 * so we delegate to OpenAIClient with configured endpoint URL.
 */

import type { LMStreamPart } from "../types";
import { normalizeProtocol } from "../types";
import type { ModelClient, ModelClientChatParams } from "./ModelClient";
import { OpenAIClient } from "./OpenAIClient";

export class LMStudioClient implements ModelClient {
	private readonly openaiClient: OpenAIClient;

	constructor(endpoint: string) {
		// LM Studio OpenAI-compatible endpoint: {endpoint}/v1
		// Example: http://localhost:1234/v1
		const baseURL = endpoint.endsWith("/") ? `${endpoint}v1` : `${endpoint}/v1`;

		// LM Studio doesn't require API key - pass dummy string (LM Studio ignores auth headers)
		// Use 'completions' API mode since LM Studio doesn't support the Responses API
		this.openaiClient = new OpenAIClient("lmstudio", baseURL, "completions");
	}

	async chat(params: ModelClientChatParams): Promise<AsyncIterable<LMStreamPart>> {
		// LM Studio only supports the Chat Completions API. Reject any
		// explicit protocol that would route to an unsupported API.
		const normalized = normalizeProtocol(params.protocol);
		if (normalized && normalized !== "openai-chat") {
			throw new Error(
				`Unsupported protocol for LM Studio: ${normalized}. LM Studio only supports openai-chat (Chat Completions API).`,
			);
		}

		// Delegate to OpenAI client, stripping protocol so the constructor-
		// time completions mode is used (not overridden by params.protocol).
		return this.openaiClient.chat({ ...params, protocol: undefined });
	}
}
