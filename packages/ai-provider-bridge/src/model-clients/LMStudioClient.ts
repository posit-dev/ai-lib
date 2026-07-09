/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * LM Studio API Client
 *
 * LM Studio provides an OpenAI-compatible API, so we delegate to OpenAIClient
 * with the configured endpoint URL. Like other OpenAI-compatible providers,
 * the configured endpoint already includes the version segment (e.g.
 * `http://localhost:1234/v1`) and is trusted as given — bare-host correction
 * happens at the config read seam (see base-url.ts and
 * `LocalProviderManager.getEndpoint`), not here.
 */

import type { LMStreamPart } from "../types";
import { normalizeProtocol } from "../types";
import type { ModelClient, ModelClientChatParams } from "./ModelClient";
import { OpenAIClient } from "./OpenAIClient";

// Host/version constants live in base-url.ts (which must stay free of this
// module's Node-only imports); re-exported here for the provider modules.
export { LMSTUDIO_API_VERSION, LMSTUDIO_HOST } from "../base-url";

export class LMStudioClient implements ModelClient {
	private readonly openaiClient: OpenAIClient;

	constructor(endpoint: string) {
		// LM Studio doesn't require API key - pass dummy string (LM Studio ignores auth headers)
		// Use 'completions' API mode since LM Studio doesn't support the Responses API
		this.openaiClient = new OpenAIClient("lmstudio", endpoint, "completions");
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
