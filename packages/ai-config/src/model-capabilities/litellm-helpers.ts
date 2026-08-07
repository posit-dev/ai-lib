/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Capability inference for models served through a LiteLLM proxy.
 *
 * A LiteLLM alias can front any upstream. Posit Assistant speaks LiteLLM's
 * unified `/v1/messages` (Anthropic-shaped) endpoint to every alias, but the
 * capabilities differ by what's behind it:
 *
 * - Claude models (direct Anthropic, Bedrock, Vertex) keep full Anthropic
 *   capabilities — explicit prompt caching and thinking-signature round-trips
 *   survive LiteLLM's translation, so the Anthropic capability table applies.
 * - Everything else (OpenAI, Gemini, local models, …) goes through LiteLLM's
 *   cross-provider translation, which silently drops the `thinking` parameter
 *   and loses reasoning continuity for non-Claude upstreams — so no
 *   `thinkingEffortLevels` are offered (same reasoning as the Databricks
 *   helper's non-Claude branch).
 */

import type { InferredModelCapabilities } from "../types.js";
import { getAnthropicModelCapabilities } from "./anthropic-helpers.js";

/**
 * Infer capabilities for a LiteLLM-served model from its underlying model id
 * (`litellm_params.model` in `/v1/model/info`, e.g. `anthropic/claude-opus-5`,
 * `bedrock/us.anthropic.claude-sonnet-4-6-...-v1:0`, `openai/gpt-5-mini`) or,
 * failing that, from a Claude-looking alias.
 *
 * @returns Anthropic capabilities for Claude-family models, or `undefined`
 *          for everything else (callers apply conservative defaults).
 */
export function getLitellmModelCapabilities(
	modelId: string,
): Partial<InferredModelCapabilities> | undefined {
	const direct = getAnthropicModelCapabilities(modelId);
	if (direct) {
		return direct;
	}
	// LiteLLM underlying ids are `<provider>/<model>`. Some providers list
	// Claude models without an `anthropic` segment (e.g.
	// `vertex_ai/claude-sonnet-4@20250514`), which the Anthropic normalizer
	// doesn't recognize — retry with the bare model portion.
	const slash = modelId.lastIndexOf("/");
	if (slash !== -1) {
		return getAnthropicModelCapabilities(modelId.slice(slash + 1));
	}
	return undefined;
}
