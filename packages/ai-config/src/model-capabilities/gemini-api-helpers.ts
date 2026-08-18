/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { InferredModelCapabilities as ModelInfo } from "../types.js";
import { getGeminiModelCapabilities } from "./gemini-helpers.js";

// ---------------------------------------------------------------------------
// Gemini API endpoint capability composition
// ---------------------------------------------------------------------------
//
// Capabilities for models served by the hosted Gemini API endpoint
// (generativelanguage.googleapis.com). This composes the shared Gemini-family
// table (gemini-helpers.ts) with rules for hosted Gemma models, which the
// Gemini-family table deliberately rejects: that table is also consumed by
// provider-agnostic inference and VS Code LM discovery, where hosted-endpoint
// semantics do not apply.
//
// Do NOT confuse this with gemma-helpers.ts — that table is the Posit AI/vLLM
// contract (`off`/`on` levels via `chat_template_kwargs`). On the Gemini API,
// Gemma 4 thinking is binary with product levels `off`/`high`, mapped to wire
// `thinkingLevel` values `minimal`/`high` by the bridge's Interactions client.

/** Capability rule: regex match against the bare `gemma-*` model ID. */
interface HostedGemmaRule {
	match: RegExp;
	family: string;
	maxInputTokens: number;
	maxContextLength: number;
	maxOutputTokens: number;
	thinkingEffortLevels: string[];
	supportsToolResultImages: boolean;
	supportedInputMediaTypes: string[];
}

/**
 * Hosted-Gemma rules, verified against the live Gemini API (2026-08-17):
 *
 * - `GET /v1beta/models` reports inputTokenLimit 262144, outputTokenLimit
 *   32768, `thinking: true` for both Gemma 4 models.
 * - Thinking is binary: wire `thinkingLevel` accepts only `minimal` (off) and
 *   `high` (on); the default when omitted is ON, so `off` must be sent
 *   explicitly. Product levels are `["off", "high"]`; the wire mapping lives
 *   in the bridge's Interactions profile.
 * - Function calling, image input (png/jpeg/gif/webp), `application/pdf`
 *   input, and images inside tool results are all accepted.
 */
const HOSTED_GEMMA_RULES: HostedGemmaRule[] = [
	{
		match: /^gemma-4-/,
		family: "gemma-4",
		maxInputTokens: 262_144,
		maxContextLength: 262_144,
		maxOutputTokens: 32_768,
		thinkingEffortLevels: ["off", "high"],
		supportsToolResultImages: true,
		supportedInputMediaTypes: [
			"image/png",
			"image/jpeg",
			"image/gif",
			"image/webp",
			"application/pdf",
		],
	},
];

/**
 * Infer capabilities for a model served by the hosted Gemini API endpoint.
 *
 * Hosted Gemma IDs (`gemma-*`) match the endpoint-specific rules above;
 * everything else delegates to the shared Gemini-family table.
 *
 * @returns A partial `ModelInfo`, or `undefined` for IDs neither the Gemma
 *          rules nor the Gemini-family table recognize.
 */
export function getGeminiApiModelCapabilities(modelId: string): Partial<ModelInfo> | undefined {
	const gemmaRule = HOSTED_GEMMA_RULES.find((rule) => rule.match.test(modelId));
	if (gemmaRule) {
		const { match: _match, ...caps } = gemmaRule;
		return caps;
	}
	return getGeminiModelCapabilities(modelId);
}
