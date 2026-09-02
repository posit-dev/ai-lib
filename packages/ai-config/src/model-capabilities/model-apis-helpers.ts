/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { InferredModelCapabilities as ModelInfo } from "../types.js";

/**
 * Capabilities for Posit AI Pass models served through Baseten's shared Model APIs
 * endpoint, keyed by exact model ID as returned by the Posit AI Pass /models
 * endpoint. Adding a Model APIs model is one entry here.
 *
 * Thinking defaults vary by model and stream back as `reasoning_content`.
 * Models with `requiresChatTemplateKwargs` expose a binary toggle via the
 * vLLM-style `chat_template_kwargs: { enable_thinking: true }` request field;
 * models with named effort levels take a top-level OpenAI-style
 * `reasoning_effort` instead.
 */
const MODEL_APIS_CAPABILITIES: Record<string, Partial<ModelInfo>> = {
	"zai-org/GLM-5.2": {
		family: "glm",
		thinkingEffortLevels: ["off", "on"],
		requiresChatTemplateKwargs: true,
		supportsImages: false,
		supportsToolResultImages: false,
		supportedInputMediaTypes: [],
		maxContextLength: 256_000,
		maxInputTokens: 256_000,
	},
	"zai-org/GLM-5.3": {
		family: "glm",
		thinkingEffortLevels: ["low", "high", "max"],
		supportsImages: false,
		supportsToolResultImages: false,
		supportedInputMediaTypes: [],
		maxOutputTokens: 262_144,
		// Artificially limited from 1M to stay within per-minute token rate limits.
		maxContextLength: 250_000,
		maxInputTokens: 250_000,
	},
	"zai-org/GLM-5.3-Flash": {
		family: "glm",
		thinkingEffortLevels: ["low", "high", "max"],
		supportsImages: true,
		supportsToolResultImages: true,
		supportedInputMediaTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
		maxOutputTokens: 131_072,
		// Artificially limited from 1M to stay within per-minute token rate limits.
		maxContextLength: 250_000,
		maxInputTokens: 250_000,
	},
	"moonshotai/Kimi-K2.7-Code": {
		family: "kimi",
		thinkingEffortLevels: ["off", "on"],
		requiresChatTemplateKwargs: true,
		supportedInputMediaTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
		maxContextLength: 262_000,
		maxInputTokens: 262_000,
	},
	"moonshotai/Kimi-K3": {
		family: "kimi",
		thinkingEffortLevels: ["off", "low", "high", "max"],
		supportedInputMediaTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
		// Kimi K3's documented max output (Moonshot API's default
		// max_completion_tokens).
		maxOutputTokens: 131_072,
		// Artificially limited to stay within per-minute token rate limits.
		maxContextLength: 250_000,
		maxInputTokens: 250_000,
	},
	"deepseek-ai/DeepSeek-V4-Flash-0731": {
		family: "deepseek-v4",
		thinkingEffortLevels: ["off", "low", "high", "max"],
		supportsImages: false,
		supportsToolResultImages: false,
		supportedInputMediaTypes: [],
		maxOutputTokens: 384_000,
		maxContextLength: 250_000,
		maxInputTokens: 250_000,
	},
};

/**
 * Look up capabilities for a Baseten Model APIs model.
 *
 * @returns The model's capability entry, or `undefined` for unknown IDs.
 */
export function getModelApisModelCapabilities(modelId: string): Partial<ModelInfo> | undefined {
	return MODEL_APIS_CAPABILITIES[modelId];
}
