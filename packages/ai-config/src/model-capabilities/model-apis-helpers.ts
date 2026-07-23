/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { InferredModelCapabilities as ModelInfo } from "../types.js";

/**
 * Capabilities for Posit AI models served through Baseten's shared Model APIs
 * endpoint, keyed by exact model ID as returned by the Posit AI /models
 * endpoint. Adding a Model APIs model is one entry here.
 *
 * These models expose binary on/off thinking via the vLLM-style
 * `chat_template_kwargs: { enable_thinking: true }` request field (thinking is
 * off by default) and stream reasoning back as `reasoning_content`.
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
	"moonshotai/Kimi-K2.7-Code": {
		family: "kimi",
		thinkingEffortLevels: ["off", "on"],
		requiresChatTemplateKwargs: true,
		supportedInputMediaTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
		maxContextLength: 262_000,
		maxInputTokens: 262_000,
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
