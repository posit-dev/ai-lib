/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { InferredModelCapabilities as ModelInfo } from "../types.js";
import { getAnthropicModelCapabilities } from "./anthropic-helpers.js";
import { getGemmaModelCapabilities } from "./gemma-helpers.js";
import { getModelApisModelCapabilities } from "./model-apis-helpers.js";

/**
 * Infer model capabilities for a Posit AI model identifier.
 *
 * Posit AI routes the Anthropic and Gemma model families plus the models
 * served through Baseten Model APIs. This helper is the single source of
 * truth for that mapping — used by both the live provider
 * (positai-provider.ts) and the Positron model-override path.
 */
export function getPositAiModelCapabilities(modelId: string): Partial<ModelInfo> | undefined {
	return (
		getAnthropicModelCapabilities(modelId) ??
		getGemmaModelCapabilities(modelId) ??
		getModelApisModelCapabilities(modelId)
	);
}
