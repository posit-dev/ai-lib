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
 * Ordered list of rules. First match wins, so tier-specific rules (e.g. Opus
 * vs Sonnet for the 4.6 generation, which share a version but have different
 * output limits) must precede any broader version-only fallback.
 *
 * Regexes use `4[-.]6` to handle both dash-style (Bedrock/Anthropic API) and
 * dot-style (OpenRouter) version separators.
 */
const CAPABILITY_RULES: CapabilityRule[] = [
	// Fable 5 / Mythos 5 use a name-as-tier naming scheme (`claude-fable-5`,
	// `claude-mythos-5`) rather than the `claude-<tier>-<version>` shape the
	// rules below match. Both have a 1M context window, 128k max output, and
	// always-on adaptive thinking — thinking cannot be disabled, so "off" is
	// not offered (unlike Opus 4.8, where thinking is off by default).
	{
		match: /^claude-fable-5/,
		family: "claude-fable-5",
		maxOutputTokens: 128_000,
		maxContextLength: 1_000_000,
		thinkingEffortLevels: ["low", "medium", "high", "xhigh", "max"],
	},
	{
		match: /^claude-mythos-5/,
		family: "claude-mythos-5",
		maxOutputTokens: 128_000,
		maxContextLength: 1_000_000,
		thinkingEffortLevels: ["low", "medium", "high", "xhigh", "max"],
	},
	// Opus 4.6–4.8 — 128k output, 1M context. Opus 4.7+ add the `xhigh` effort
	// level; 4.6 does not.
	{
		match: /^claude-opus-4[-.]8/,
		family: "claude-4.8",
		maxOutputTokens: 128_000,
		maxContextLength: 1_000_000,
		thinkingEffortLevels: ["off", "low", "medium", "high", "xhigh", "max"],
	},
	{
		match: /^claude-opus-4[-.]7/,
		family: "claude-4.7",
		maxOutputTokens: 128_000,
		maxContextLength: 1_000_000,
		thinkingEffortLevels: ["off", "low", "medium", "high", "xhigh", "max"],
	},
	{
		match: /^claude-opus-4[-.]6/,
		family: "claude-4.6",
		maxOutputTokens: 128_000,
		maxContextLength: 1_000_000,
		thinkingEffortLevels: ["off", "low", "medium", "high", "max"],
	},
	// Sonnet 4.6 — 64k output, 1M context.
	{
		match: /^claude-sonnet-4[-.]6/,
		family: "claude-4.6",
		maxOutputTokens: 64_000,
		maxContextLength: 1_000_000,
		thinkingEffortLevels: ["off", "low", "medium", "high", "max"],
	},
	// Haiku 4.5 — 64k output, 200k context (no effort support).
	{
		match: /^claude-haiku-4[-.]5/,
		family: "claude-4.5",
		maxOutputTokens: 64_000,
		maxContextLength: 200_000,
	},
	{ match: /^claude-\w+-4[-.]5/, family: "claude-4.5", maxOutputTokens: 16_000 },
	{ match: /^claude-\w+-4/, family: "claude-4", maxOutputTokens: 16_000 },
	{ match: /^claude-3/, family: "claude-3", maxOutputTokens: 8_192 },
];

/**
 * Fallback max output for unrecognized Claude models (e.g. a new model served
 * before a rule is added). 64k is the floor across all current Claude tiers,
 * so it never exceeds a model's real cap — there is no clamping downstream, and
 * the API rejects requests whose `max_tokens` is above the model limit. A model
 * with a higher real cap is under-utilized until a rule is added, never failed.
 */
const DEFAULT_CLAUDE_MAX_OUTPUT = 64_000;

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

	const maxContextLength = rule?.maxContextLength ?? 200_000;
	const maxOutputTokens = rule?.maxOutputTokens ?? DEFAULT_CLAUDE_MAX_OUTPUT;

	return {
		// Input and output share one context window, so the input ceiling is the
		// window minus the reserved output budget (mirrors the OpenAI helper).
		maxInputTokens: maxContextLength - maxOutputTokens,
		maxContextLength,
		maxOutputTokens,
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
