/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Ollama API Client
 *
 * Uses ai-sdk-ollama to talk to Ollama's native /api/chat endpoint.
 * This enables Ollama-specific features like num_ctx and thinking/reasoning
 * that are not available through the OpenAI-compatible endpoint.
 */

import type { ModelMessage } from "ai";
import { streamText } from "ai";
import { createOllama } from "ai-sdk-ollama";

import type { StepLogger } from "../StepLogger";
import {
	hasImagesInToolResults,
	transformToolResultImagesForCompletions,
} from "../tool-result-images";
import type { AiToolWithJsonSchema, CancellationToken, LMStreamPart } from "../types";
import { isThinkingEnabled } from "../utils";
import {
	convertAiSdkStreamToPlatform,
	createAbortControllerFromToken,
	createStepLogger,
} from "./ai-sdk-helpers";
import type { ModelClient } from "./ModelClient";

/** The `think` parameter type accepted by Ollama's native API. */
type OllamaThinkParam = boolean | "low" | "medium" | "high";

/** Valid level strings for Ollama's `think` parameter. */
const OLLAMA_THINK_LEVELS = new Set<string>(["low", "medium", "high"]);

/**
 * Map a resolved thinkingEffort string to Ollama's `think` model setting.
 *
 * Binary models (QwQ, Qwen 3, etc.) use effort level "on" → `true`.
 * Level models (GPT-OSS) use effort levels "low"/"medium"/"high" → pass as string.
 * "off" → `false`. `undefined` (model doesn't support thinking) → `undefined` (omit).
 */
export function ollamaThinkParam(thinkingEffort: string | undefined): OllamaThinkParam | undefined {
	if (isThinkingEnabled(thinkingEffort)) {
		// Binary models use "on" → boolean true.
		// Level models use "low"/"medium"/"high" → pass the level string.
		if (thinkingEffort === "on") return true;
		if (OLLAMA_THINK_LEVELS.has(thinkingEffort!)) {
			return thinkingEffort as "low" | "medium" | "high";
		}
		// Fallback for unrecognized effort → enable thinking
		return true;
	}
	if (thinkingEffort === "off") {
		return false;
	}
	// undefined — model doesn't support thinking; omit param
	return undefined;
}

export class OllamaClient implements ModelClient {
	private readonly endpoint: string;

	constructor(endpoint: string) {
		// Store the server root (e.g., http://localhost:11434).
		// The ai-sdk-ollama provider appends API paths internally.
		this.endpoint = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
	}

	async chat(params: {
		model: string;
		messages: ModelMessage[];
		systemPrompt?: string;
		maxOutputTokens?: number;
		tools?: Record<string, AiToolWithJsonSchema>;
		cancellationToken: CancellationToken;
		thinkingEffort?: string;
		contextLength?: number;
		metadata?: {
			sessionId?: string;
		};
		stepLoggers?: StepLogger[];
	}): Promise<AsyncIterable<LMStreamPart>> {
		// Create Ollama provider pointing at the server root
		const provider = createOllama({ baseURL: this.endpoint });

		// Build model settings
		const think = ollamaThinkParam(params.thinkingEffort);
		const model = provider(params.model, {
			...(think !== undefined && { think }),
			options: {
				...(params.contextLength !== undefined && { num_ctx: params.contextLength }),
			},
		});

		// Create abort controller with cleanup to prevent EventEmitter memory leaks
		const { abortController, cleanup } = createAbortControllerFromToken(params.cancellationToken);

		// Transform tool result images (Ollama's native API has the same limitation)
		let messagesToSend = params.messages;
		if (hasImagesInToolResults(params.messages)) {
			messagesToSend = transformToolResultImagesForCompletions(params.messages);
		}

		// Stream the response
		const result = streamText({
			model,
			messages: messagesToSend,
			system: params.systemPrompt,
			maxOutputTokens: params.maxOutputTokens,
			tools: params.tools,
			toolChoice: params.tools ? "auto" : undefined,
			abortSignal: abortController.signal,
			// Capture raw JSON on each step finish
			onStepFinish: createStepLogger(params.stepLoggers || [], "ollama", params.model),
		});

		// Convert to platform-agnostic format with cleanup on completion
		return convertAiSdkStreamToPlatform(result.fullStream, cleanup);
	}
}
