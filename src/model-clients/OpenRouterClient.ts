/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { ModelMessage } from "ai";
import { streamText } from "ai";

import { safeSdkCustomHeaders } from "../custom-headers";
import type { StepLogger } from "../StepLogger";
import type { AiToolWithJsonSchema, CancellationToken, LMStreamPart } from "../types";
import { isThinkingEnabled } from "../utils";
import {
	convertAiSdkStreamToPlatform,
	createAbortControllerFromToken,
	createStepLogger,
} from "./ai-sdk-helpers";
import type { ModelClient } from "./ModelClient";

type OpenRouterReasoningSettings = { effort: "high" | "medium" | "low" | "none" };

/** Map a resolved thinkingEffort string to OpenRouter's reasoning settings. */
export function openRouterReasoningSettings(
	thinkingEffort: string | undefined,
): OpenRouterReasoningSettings | undefined {
	if (thinkingEffort === undefined) {
		return undefined;
	}
	if (!isThinkingEnabled(thinkingEffort)) {
		return { effort: "none" };
	}
	const validEfforts = new Set(["low", "medium", "high"]);
	const effort = validEfforts.has(thinkingEffort)
		? (thinkingEffort as "low" | "medium" | "high")
		: "medium";
	return { effort };
}

export class OpenRouterClient implements ModelClient {
	private readonly apiKey: string;
	private readonly customHeaders?: Record<string, string>;

	constructor(apiKey: string, customHeaders?: Record<string, string>) {
		this.apiKey = apiKey;
		this.customHeaders = customHeaders;
	}

	async chat(params: {
		model: string;
		messages: ModelMessage[];
		systemPrompt?: string;
		maxOutputTokens?: number;
		tools?: Record<string, AiToolWithJsonSchema>;
		cancellationToken: CancellationToken;
		thinkingEffort?: string;
		metadata?: {
			sessionId?: string;
			conversationId?: string;
		};
		stepLoggers?: StepLogger[];
	}): Promise<AsyncIterable<LMStreamPart>> {
		const headers = safeSdkCustomHeaders(this.customHeaders);
		const provider = createOpenRouter({
			apiKey: this.apiKey,
			appName: "Posit Assistant",
			appUrl: "https://posit.co",
			...(headers && { headers }),
		});

		const model = provider.chat(params.model, {
			reasoning: openRouterReasoningSettings(params.thinkingEffort),
		});

		const { abortController, cleanup } = createAbortControllerFromToken(params.cancellationToken);

		const result = streamText({
			model,
			messages: params.messages,
			system: params.systemPrompt,
			maxOutputTokens: params.maxOutputTokens,
			tools: params.tools,
			toolChoice: params.tools ? "auto" : undefined,
			abortSignal: abortController.signal,
			onStepFinish: createStepLogger(params.stepLoggers || [], "openrouter", params.model),
		});

		return convertAiSdkStreamToPlatform(result.fullStream, cleanup);
	}
}
