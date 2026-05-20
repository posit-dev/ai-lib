/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Google Gemini API Client
 *
 * Implements ModelClient interface for Gemini models
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { ModelMessage } from "ai";
import { streamText } from "ai";

import type { StepLogger } from "../StepLogger";
import type { AiToolWithJsonSchema, CancellationToken, LMStreamPart } from "../types";
import {
	convertAiSdkStreamToPlatform,
	createAbortControllerFromToken,
	createStepLogger,
} from "./ai-sdk-helpers";
import type { ModelClient } from "./ModelClient";

// ---------------------------------------------------------------------------
// Gemini thinking configuration
// ---------------------------------------------------------------------------

/**
 * Per-model thinkingBudget tables for Gemini 2.5 models.
 * Ranges from https://ai.google.dev/gemini-api/docs/thinking#levels-budgets
 *
 * Each entry maps our effort levels to token budgets within the model's
 * documented range. "minimal" maps to 0 where supported; models that cannot
 * reduce thinking below "low" omit "minimal" from their thinkingEffortLevels.
 */
interface BudgetConfig {
	match: RegExp;
	budgets: Record<string, number>;
}

const GEMINI_25_BUDGETS: BudgetConfig[] = [
	{
		// 2.5 Flash Lite: range 512–24576, disable with 0
		match: /^gemini-2\.5-flash-lite/,
		budgets: { minimal: 0, low: 512, medium: 8192, high: 24576 },
	},
	{
		// 2.5 Flash: range 0–24576, disable with 0
		match: /^gemini-2\.5-flash/,
		budgets: { minimal: 0, low: 2048, medium: 8192, high: 24576 },
	},
	{
		// 2.5 Pro: range 128–32768, cannot disable
		match: /^gemini-2\.5/,
		budgets: { low: 2048, medium: 8192, high: 32768 },
	},
];

/** Default budget table for unrecognized 2.5 models. */
const DEFAULT_25_BUDGETS: Record<string, number> = {
	minimal: 0,
	low: 2048,
	medium: 8192,
	high: 24576,
};

/** Valid Gemini 3 thinkingLevel values. */
const VALID_GEMINI3_LEVELS = new Set(["minimal", "low", "medium", "high"]);

/**
 * Build `providerOptions.google` for Gemini thinking configuration.
 *
 * - `undefined` effort (model doesn't support thinking): no config
 * - Gemini 2.5: maps effort to model-specific `thinkingBudget`
 * - Gemini 3+: maps effort to `thinkingLevel` (values pass through directly)
 */
export function geminiThinkingConfig(
	thinkingEffort: string | undefined,
	modelId: string,
):
	| {
			google: {
				thinkingConfig: {
					thinkingBudget?: number;
					thinkingLevel?: string;
					includeThoughts?: boolean;
				};
			};
	  }
	| undefined {
	if (thinkingEffort === undefined) return undefined;

	// Gemini 2.5 uses token-based thinkingBudget
	if (modelId.startsWith("gemini-2.5")) {
		const config = GEMINI_25_BUDGETS.find((c) => c.match.test(modelId));
		const budgets = config?.budgets ?? DEFAULT_25_BUDGETS;
		const thinkingBudget = budgets[thinkingEffort] ?? budgets.medium;

		return {
			google: {
				thinkingConfig: {
					thinkingBudget,
					...(thinkingBudget > 0 && { includeThoughts: true }),
				},
			},
		};
	}

	// Gemini 3+ uses named thinkingLevel
	const thinkingLevel = VALID_GEMINI3_LEVELS.has(thinkingEffort) ? thinkingEffort : "medium";

	return {
		google: {
			thinkingConfig: {
				thinkingLevel,
				includeThoughts: true,
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class GeminiClient implements ModelClient {
	private readonly apiKey: string;
	private readonly baseURL?: string;

	constructor(apiKey: string, baseURL?: string) {
		this.apiKey = apiKey;
		this.baseURL = baseURL;
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
		// Create Google Generative AI provider
		const provider = createGoogleGenerativeAI({
			apiKey: this.apiKey,
			...(this.baseURL && { baseURL: this.baseURL }),
		});
		const model = provider(params.model);

		// Create abort controller with cleanup to prevent EventEmitter memory leaks
		const { abortController, cleanup } = createAbortControllerFromToken(params.cancellationToken);

		// Stream the response
		const result = streamText({
			model,
			messages: params.messages,
			system: params.systemPrompt,
			maxOutputTokens: params.maxOutputTokens,
			tools: params.tools,
			toolChoice: params.tools ? "auto" : undefined,
			abortSignal: abortController.signal,
			providerOptions: geminiThinkingConfig(params.thinkingEffort, params.model),
			// Capture raw JSON on each step finish
			onStepFinish: createStepLogger(params.stepLoggers || [], "gemini", params.model),
		});

		// Convert to platform-agnostic format with cleanup on completion
		return convertAiSdkStreamToPlatform(result.fullStream, cleanup);
	}
}
