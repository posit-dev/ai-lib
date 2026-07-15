/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025-2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { InferredModelCapabilities as ModelInfo } from "../types.js";

const OPENAI_THINKING_EFFORT_LEVELS = ["off", "low", "medium", "high"];

/**
 * Determine OpenAI model capabilities based on ID.
 *
 * @returns A partial `ModelInfo` with token limits and capability flags,
 *          or `undefined` for non-OpenAI models.
 */
export function getOpenAIModelCapabilities(modelId: string): Partial<ModelInfo> | undefined {
	// o-series reasoning models
	if (modelId.startsWith("o1-") || modelId.startsWith("o3-")) {
		return {
			family: "o-series",
			supportsTools: false, // o-series doesn't support tools yet
			supportsImages: true, // Can accept image inputs
			supportedInputMediaTypes: [
				"image/png",
				"image/jpeg",
				"image/gif",
				"image/webp",
				"application/pdf",
			],
			supportsToolResultImages: true,
			maxContextLength: 200000,
			maxOutputTokens: 32768,
			thinkingEffortLevels: OPENAI_THINKING_EFFORT_LEVELS,
		};
	}

	// GPT-5 Chat aliases use ChatGPT-oriented limits rather than the Responses API reasoning limits.
	if (modelId === "gpt-5-chat-latest" || /^gpt-5\.\d+-chat-latest$/.test(modelId)) {
		return {
			family: modelId.startsWith("gpt-5.3") ? "gpt-5.3" : "gpt-5",
			supportsTools: true,
			supportsImages: true,
			supportedInputMediaTypes: [
				"image/png",
				"image/jpeg",
				"image/gif",
				"image/webp",
				"application/pdf",
			],
			supportsToolResultImages: true,
			maxContextLength: 128000,
			maxOutputTokens: 16384,
		};
	}

	// GPT-5.4 flagship and pro models use the new 1.05M context window.
	if (modelId.startsWith("gpt-5.4-pro")) {
		return {
			family: "gpt-5.4",
			supportsTools: true,
			supportsImages: true,
			supportedInputMediaTypes: [
				"image/png",
				"image/jpeg",
				"image/gif",
				"image/webp",
				"application/pdf",
			],
			supportsToolResultImages: true,
			maxContextLength: 1050000,
			maxOutputTokens: 128000,
			thinkingEffortLevels: OPENAI_THINKING_EFFORT_LEVELS,
		};
	}

	// GPT-5.4 mini and nano keep the 400k context window.
	if (modelId.startsWith("gpt-5.4-mini") || modelId.startsWith("gpt-5.4-nano")) {
		return {
			family: "gpt-5.4",
			supportsTools: true,
			supportsImages: true,
			supportedInputMediaTypes: [
				"image/png",
				"image/jpeg",
				"image/gif",
				"image/webp",
				"application/pdf",
			],
			supportsToolResultImages: true,
			maxContextLength: 400000,
			maxOutputTokens: 128000,
			thinkingEffortLevels: OPENAI_THINKING_EFFORT_LEVELS,
		};
	}

	if (modelId.startsWith("gpt-5.4")) {
		return {
			family: "gpt-5.4",
			supportsTools: true,
			supportsImages: true,
			supportedInputMediaTypes: [
				"image/png",
				"image/jpeg",
				"image/gif",
				"image/webp",
				"application/pdf",
			],
			supportsToolResultImages: true,
			maxContextLength: 1050000,
			maxOutputTokens: 128000,
			thinkingEffortLevels: OPENAI_THINKING_EFFORT_LEVELS,
		};
	}

	// GPT-5 series (400k context window)
	if (modelId.startsWith("gpt-5")) {
		return {
			family: modelId.startsWith("gpt-5.3")
				? "gpt-5.3"
				: modelId.startsWith("gpt-5.2")
					? "gpt-5.2"
					: "gpt-5",
			supportsTools: true,
			supportsImages: true,
			supportedInputMediaTypes: [
				"image/png",
				"image/jpeg",
				"image/gif",
				"image/webp",
				"application/pdf",
			],
			supportsToolResultImages: true,
			maxContextLength: 400000,
			maxOutputTokens: 128000,
			thinkingEffortLevels: OPENAI_THINKING_EFFORT_LEVELS,
		};
	}

	// GPT-4.1 series (1M context)
	if (modelId.startsWith("gpt-4.1")) {
		return {
			family: "gpt-4.1",
			supportsTools: true,
			supportsImages: true, // Can accept image inputs
			supportedInputMediaTypes: [
				"image/png",
				"image/jpeg",
				"image/gif",
				"image/webp",
				"application/pdf",
			],
			supportsToolResultImages: true,
			maxContextLength: 1000000,
			maxOutputTokens: 16384,
		};
	}

	// GPT-4o series
	if (modelId.startsWith("gpt-4o")) {
		return {
			family: "gpt-4o",
			supportsTools: true,
			supportsImages: true, // Can accept image inputs
			supportedInputMediaTypes: [
				"image/png",
				"image/jpeg",
				"image/gif",
				"image/webp",
				"application/pdf",
			],
			supportsToolResultImages: true,
			maxContextLength: 128000,
			maxOutputTokens: 16384,
		};
	}

	// GPT-4 Turbo
	if (modelId.includes("gpt-4-turbo")) {
		return {
			family: "gpt-4-turbo",
			supportsTools: true,
			supportsImages: true, // GPT-4 Turbo has vision
			supportedInputMediaTypes: [
				"image/png",
				"image/jpeg",
				"image/gif",
				"image/webp",
				"application/pdf",
			],
			supportsToolResultImages: true,
			maxContextLength: 128000,
			maxOutputTokens: 4096,
		};
	}

	// GPT-3.5
	if (modelId.startsWith("gpt-3.5")) {
		return {
			family: "gpt-3.5",
			supportsTools: true,
			supportsImages: false, // GPT-3.5 cannot accept images
			supportsToolResultImages: false,
			maxContextLength: 16385,
			maxOutputTokens: 4096,
		};
	}

	return undefined;
}

/**
 * OpenAI models share a context window; reserve space for output tokens.
 *
 * Accepts a minimal structural type — only the two token fields are read — so
 * callers passing any capability shape (bridge `Partial<ModelInfo>`,
 * `Partial<InferredModelCapabilities>`, …) stay assignable regardless of how
 * each type narrows unrelated fields such as `protocol`.
 */
export function openaiMaxInputTokens(model: {
	maxContextLength?: number;
	maxOutputTokens?: number;
}): number | undefined {
	if (model.maxContextLength === undefined || model.maxOutputTokens === undefined) {
		return undefined;
	}
	return model.maxContextLength - model.maxOutputTokens;
}
