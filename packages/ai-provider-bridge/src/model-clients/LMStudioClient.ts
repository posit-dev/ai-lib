/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * LM Studio API Client
 *
 * LM Studio provides an OpenAI-compatible API, so we delegate to OpenAIClient
 * with the configured endpoint URL. Like other OpenAI-compatible providers,
 * the configured endpoint is expected to already include the version segment
 * (e.g. `http://localhost:1234/v1`); the bare default host is normalized as a
 * courtesy.
 */

import type { LMStreamPart } from "../types";
import { normalizeProtocol } from "../types";
import { normalizeProviderBaseUrl } from "../utils";
import type { ModelClient, ModelClientChatParams } from "./ModelClient";
import { OpenAIClient } from "./OpenAIClient";

/** LM Studio default local server host (no version segment). */
export const LMSTUDIO_HOST = "http://localhost:1234";

export class LMStudioClient implements ModelClient {
	private readonly openaiClient: OpenAIClient;

	constructor(endpoint: string) {
		// Endpoint includes the version segment (e.g. http://localhost:1234/v1);
		// the exact bare default host gets /v1 appended for backward compatibility.
		const baseURL = normalizeProviderBaseUrl(endpoint, LMSTUDIO_HOST, "v1");

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
