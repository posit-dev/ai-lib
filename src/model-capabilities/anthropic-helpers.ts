/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025-2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Type guards and utilities for Anthropic provider metadata.
 */

import type { ModelInfo } from "../types";

// ---------------------------------------------------------------------------
// Anthropic model capability inference
// ---------------------------------------------------------------------------

/** Capability rule: regex match against normalized Claude model ID. */
interface CapabilityRule {
	match: RegExp;
	family: string;
	maxOutputTokens: number;
	maxContextLength?: number; // defaults to 200_000 when omitted
	thinkingEffortLevels?: string[];
}

/**
 * Ordered list of rules. First match wins.
 * Regexes use `4[-.]6` to handle both dash-style (Bedrock/Anthropic API) and
 * dot-style (OpenRouter) version separators.
 */
const CAPABILITY_RULES: CapabilityRule[] = [
	{
		match: /^claude-\w+-4[-.]8/,
		family: "claude-4.8",
		maxOutputTokens: 128_000,
		maxContextLength: 1_000_000,
		thinkingEffortLevels: ["off", "low", "medium", "high", "xhigh", "max"],
	},
	{
		match: /^claude-\w+-4[-.]7/,
		family: "claude-4.7",
		maxOutputTokens: 16_000,
		thinkingEffortLevels: ["off", "low", "medium", "high", "xhigh", "max"],
	},
	{
		match: /^claude-\w+-4[-.]6/,
		family: "claude-4.6",
		maxOutputTokens: 16_000,
		thinkingEffortLevels: ["off", "low", "medium", "high", "max"],
	},
	{ match: /^claude-\w+-4[-.]5/, family: "claude-4.5", maxOutputTokens: 16_000 },
	{ match: /^claude-\w+-4/, family: "claude-4", maxOutputTokens: 16_000 },
	{ match: /^claude-3/, family: "claude-3", maxOutputTokens: 8_192 },
];

/** Fallback max output for unrecognized Claude models. */
const DEFAULT_CLAUDE_MAX_OUTPUT = 16_000;

/**
 * Strip provider-specific prefixes to get the bare `claude-*` model ID.
 *
 * Handles:
 *  - Bare: `claude-opus-4-6`
 *  - Bedrock direct: `anthropic.claude-opus-4-6-v1:0`
 *  - Bedrock inference profile: `us.anthropic.claude-sonnet-4-5-20250929-v1:0`
 *  - Bedrock ARN: `arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-v2:0`
 *  - OpenRouter: `anthropic/claude-sonnet-4.6`
 *
 * @returns The bare `claude-*` portion, or `undefined` for non-Claude IDs.
 */
function normalizeAnthropicModelId(modelId: string): string | undefined {
	// Already a bare Claude ID
	if (modelId.startsWith("claude-")) {
		return modelId;
	}

	// Provider-prefixed: require `anthropic` at start-of-string or preceded by
	// a segment boundary ([.:/]) to avoid false-positives like `myanthropicmodel`.
	const m = modelId.match(/(?:^|[.:/])anthropic[./](claude-.+)$/);
	return m?.[1];
}

/**
 * Infer Anthropic model capabilities from any provider-specific model ID.
 *
 * @returns A partial `ModelInfo` with token limits, family, and capability
 *          flags, or `undefined` for non-Claude models.
 */
export function getAnthropicModelCapabilities(modelId: string): Partial<ModelInfo> | undefined {
	const normalized = normalizeAnthropicModelId(modelId);
	if (!normalized) {
		return undefined;
	}

	// Find first matching rule
	const rule = CAPABILITY_RULES.find((r) => r.match.test(normalized));

	return {
		maxInputTokens: 200_000,
		maxContextLength: rule?.maxContextLength ?? 200_000,
		maxOutputTokens: rule?.maxOutputTokens ?? DEFAULT_CLAUDE_MAX_OUTPUT,
		supportsToolResultImages: true,
		supportedInputMediaTypes: [
			"image/png",
			"image/jpeg",
			"image/gif",
			"image/webp",
			"application/pdf",
		],
		family: rule?.family,
		thinkingEffortLevels: rule?.thinkingEffortLevels,
	};
}
