/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * LM Studio API Client
 *
 * LM Studio provides OpenAI-compatible API at /v1/chat/completions,
 * so we delegate to OpenAIClient with configured endpoint URL.
 */

import type { ModelMessage } from "ai";

import type { StepLogger } from "../StepLogger";
import type { AiToolWithJsonSchema, CancellationToken, LMStreamPart } from "../types";
import type { ModelClient } from "./ModelClient";
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

	async chat(params: {
		model: string;
		messages: ModelMessage[];
		systemPrompt?: string;
		maxOutputTokens?: number;
		tools?: Record<string, AiToolWithJsonSchema>;
		cancellationToken: CancellationToken;
		metadata?: {
			sessionId?: string;
		};
		stepLoggers?: StepLogger[];
	}): Promise<AsyncIterable<LMStreamPart>> {
		// Delegate to OpenAI client
		return this.openaiClient.chat(params);
	}
}
