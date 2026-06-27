/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createDeepSeek } from "@ai-sdk/deepseek";
import { streamText } from "ai";

import { safeSdkCustomHeaders } from "../custom-headers";
import type { LMStreamPart } from "../types";
import { isThinkingEnabled } from "../utils";
import {
	convertAiSdkStreamToPlatform,
	createAbortControllerFromToken,
	createStepLogger,
} from "./ai-sdk-helpers";
import type { ModelClient, ModelClientChatParams } from "./ModelClient";

/** Map our thinking effort string to DeepSeek's reasoning_effort parameter. */
function mapReasoningEffort(effort: string): string {
	switch (effort) {
		case "max":
			return "max";
		case "high":
		default:
			return "high";
	}
}

/**
 * Create a fetch wrapper that injects `reasoning_effort` into the request body.
 * The @ai-sdk/deepseek v2.x SDK handles the `thinking` toggle but does not
 * expose `reasoning_effort`, so we inject it at the fetch layer.
 *
 * At some point in the future, @ai-sdk/deepseek may expose `reasoning_effort`
 * directly, at which point this wrapper can be removed.
 */
function createFetchWithReasoningEffort(effort: string): typeof globalThis.fetch {
	const reasoningEffort = mapReasoningEffort(effort);
	return async (input: string | URL | globalThis.Request, init?: RequestInit) => {
		if (init?.body && typeof init.body === "string") {
			try {
				const body = JSON.parse(init.body);
				body.reasoning_effort = reasoningEffort;
				init = { ...init, body: JSON.stringify(body) };
			} catch {
				// Not JSON — pass through unchanged
			}
		}
		return globalThis.fetch(input, init);
	};
}

export class DeepSeekClient implements ModelClient {
	private readonly apiKey: string;
	private readonly baseURL?: string;
	private readonly customHeaders?: Record<string, string>;

	constructor(apiKey: string, baseURL?: string, customHeaders?: Record<string, string>) {
		this.apiKey = apiKey;
		this.baseURL = baseURL;
		this.customHeaders = customHeaders;
	}

	async chat(params: ModelClientChatParams): Promise<AsyncIterable<LMStreamPart>> {
		const effectiveBaseUrl = params.baseUrl ?? this.baseURL;
		const thinkingOn = isThinkingEnabled(params.thinkingEffort);

		const headers = safeSdkCustomHeaders(this.customHeaders);
		const provider = createDeepSeek({
			apiKey: this.apiKey,
			...(effectiveBaseUrl && { baseURL: effectiveBaseUrl }),
			...(thinkingOn && {
				fetch: createFetchWithReasoningEffort(params.thinkingEffort!),
			}),
			...(headers && { headers }),
		});

		const model = provider.chat(params.model);

		const { abortController, cleanup } = createAbortControllerFromToken(params.cancellationToken);

		const result = streamText({
			model,
			messages: params.messages,
			system: params.systemPrompt,
			maxOutputTokens: params.maxOutputTokens,
			tools: params.tools,
			toolChoice: params.tools ? "auto" : undefined,
			abortSignal: abortController.signal,
			providerOptions: {
				deepseek: {
					thinking: { type: thinkingOn ? ("enabled" as const) : ("disabled" as const) },
				},
			},
			onStepFinish: createStepLogger(params.stepLoggers || [], "deepseek", params.model),
		});

		return convertAiSdkStreamToPlatform(result.fullStream, cleanup);
	}
}
