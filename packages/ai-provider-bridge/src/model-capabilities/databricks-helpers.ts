/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Capability inference for Databricks serving endpoints.
 *
 * The serving-endpoints list API exposes no token-limit or modality metadata,
 * so capabilities are inferred from the underlying model identity (foundation
 * model name, external model name, or endpoint name). Unknown identities get
 * no override and fall back to the provider's conservative defaults.
 */

import type { ModelInfo } from "../types";
import { getAnthropicModelCapabilities } from "./anthropic-helpers";
import { getOpenAIModelCapabilities } from "./openai-helpers";

/**
 * Image MIME types accepted through the Databricks OpenAI-compatible surface.
 * PDF input (which the upstream Anthropic/OpenAI helpers include) is not
 * reliably supported across Databricks serving endpoints, so it is excluded.
 */
const DATABRICKS_IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/**
 * Strip Databricks-specific prefixes to get the bare upstream model identity.
 *
 * Handles:
 *  - Pay-per-token foundation models: `databricks-claude-sonnet-4-5`
 *  - Unity Catalog system models: `system.ai.claude-sonnet-4-5`
 */
function normalizeDatabricksModelId(modelId: string): string {
	return modelId.replace(/^system\.ai\./, "").replace(/^databricks-/, "");
}

/**
 * Infer model capabilities for a Databricks serving endpoint from the
 * underlying model identity.
 *
 * Thinking-effort levels are deliberately dropped: reasoning-effort support is
 * inconsistent across the Databricks OpenAI-compatible surface, so v1 does not
 * offer thinking controls for Databricks models.
 *
 * @param modelIdentity - Best-known model identity (foundation model name,
 *                        external model name, entity name, or endpoint name)
 * @returns A partial `ModelInfo` override, or `undefined` for unrecognized models.
 */
export function getDatabricksModelCapabilities(
	modelIdentity: string,
): Partial<ModelInfo> | undefined {
	const normalized = normalizeDatabricksModelId(modelIdentity);

	const claudeCapabilities = getAnthropicModelCapabilities(normalized);
	if (claudeCapabilities) {
		const { thinkingEffortLevels: _dropped, ...capabilities } = claudeCapabilities;
		return {
			...capabilities,
			supportsImages: true,
			supportedInputMediaTypes: DATABRICKS_IMAGE_MEDIA_TYPES,
		};
	}

	const openaiCapabilities = getOpenAIModelCapabilities(normalized);
	if (openaiCapabilities) {
		const {
			thinkingEffortLevels: _dropped,
			supportedInputMediaTypes: _droppedMediaTypes,
			...capabilities
		} = openaiCapabilities;
		return {
			...capabilities,
			...(capabilities.supportsImages
				? { supportedInputMediaTypes: DATABRICKS_IMAGE_MEDIA_TYPES }
				: {}),
		};
	}

	return undefined;
}
