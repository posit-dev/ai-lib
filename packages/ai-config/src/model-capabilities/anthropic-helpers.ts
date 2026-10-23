/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025-2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Type guards and utilities for Anthropic provider metadata.
 */

import type { InferredModelCapabilities as ModelInfo } from "../types.js";

// ---------------------------------------------------------------------------
// Anthropic model capability inference
// ---------------------------------------------------------------------------

/** Limits and thinking levels a capability entry assigns to a Claude model. */
interface ClaudeCapabilities {
	family: string;
	maxOutputTokens: number;
	maxContextLength?: number; // defaults to 200_000 when omitted
	thinkingEffortLevels?: string[];
}

/** A model in the modern `claude-<tier>-<major>[-<minor>]` naming scheme. */
interface TierEntry extends ClaudeCapabilities {
	tier: string;
	version: readonly [major: number, minor: number];
}

/**
 * Modern Claude models, keyed by tier and version. A requested id takes the
 * entry in its tier with the greatest version at or below its own, so the
 * newest entry in a tier is the fallback for later versions
 * (`claude-sonnet-5-7` → Sonnet 5.5) and adding a model is still one entry.
 * Order does not matter. Limits are per tier because tiers of one generation
 * differ (Opus 4.6 has 128k output, Sonnet 4.6 64k).
 */
const TIER_ENTRIES: TierEntry[] = [
	// Fable 5 / Mythos 5 — 1M context, 128k output, always-on adaptive thinking.
	// Thinking cannot be disabled, so "off" is not offered (unlike Opus 4.8,
	// where thinking is off by default). Point releases (`claude-fable-5-1`)
	// share the same limits.
	{
		tier: "fable",
		version: [5, 0],
		family: "claude-fable-5",
		maxOutputTokens: 128_000,
		maxContextLength: 1_000_000,
		thinkingEffortLevels: ["low", "medium", "high", "xhigh", "max"],
	},
	{
		tier: "mythos",
		version: [5, 0],
		family: "claude-mythos-5",
		maxOutputTokens: 128_000,
		maxContextLength: 1_000_000,
		thinkingEffortLevels: ["low", "medium", "high", "xhigh", "max"],
	},
	// Sonnet 5.5 — 128k output, 1M context. Adaptive thinking is on by default
	// (default effort "high"), and `thinking: {type: "disabled"}` returns a 400,
	// so omitting thinking does not turn it off. Its lowest setting is the
	// separate `between_tools` mode, which the clients don't send, so "off" is
	// not offered — same precedent as Opus 5.5 below.
	{
		tier: "sonnet",
		version: [5, 5],
		family: "claude-5.5",
		maxOutputTokens: 128_000,
		maxContextLength: 1_000_000,
		thinkingEffortLevels: ["low", "medium", "high", "xhigh", "max"],
	},
	// Sonnet 5 — 128k output, 1M context. Same thinking profile as Opus 4.8
	// (adaptive thinking, off by default), so it offers the full effort range.
	{
		tier: "sonnet",
		version: [5, 0],
		family: "claude-5",
		maxOutputTokens: 128_000,
		maxContextLength: 1_000_000,
		thinkingEffortLevels: ["off", "low", "medium", "high", "xhigh", "max"],
	},
	// Opus 5.5 — 128k output, 1M context. Thinking is adaptive and always on
	// (default effort "medium"), so "off" is not offered — same precedent as
	// Fable/Mythos above.
	{
		tier: "opus",
		version: [5, 5],
		family: "claude-5.5",
		maxOutputTokens: 128_000,
		maxContextLength: 1_000_000,
		thinkingEffortLevels: ["low", "medium", "high", "xhigh", "max"],
	},
	// Opus 5 — 128k output, 1M context. Thinking is on by default (adaptive),
	// but it can still be disabled, so "off" is offered alongside the full
	// effort range.
	{
		tier: "opus",
		version: [5, 0],
		family: "claude-5",
		maxOutputTokens: 128_000,
		maxContextLength: 1_000_000,
		thinkingEffortLevels: ["off", "low", "medium", "high", "xhigh", "max"],
	},
	// Opus 4.6–4.8 — 128k output, 1M context. Opus 4.7+ add the `xhigh` effort
	// level; 4.6 does not.
	{
		tier: "opus",
		version: [4, 8],
		family: "claude-4.8",
		maxOutputTokens: 128_000,
		maxContextLength: 1_000_000,
		thinkingEffortLevels: ["off", "low", "medium", "high", "xhigh", "max"],
	},
	{
		tier: "opus",
		version: [4, 7],
		family: "claude-4.7",
		maxOutputTokens: 128_000,
		maxContextLength: 1_000_000,
		thinkingEffortLevels: ["off", "low", "medium", "high", "xhigh", "max"],
	},
	{
		tier: "opus",
		version: [4, 6],
		family: "claude-4.6",
		maxOutputTokens: 128_000,
		maxContextLength: 1_000_000,
		thinkingEffortLevels: ["off", "low", "medium", "high", "max"],
	},
	// Sonnet 4.6 — 64k output, 1M context.
	{
		tier: "sonnet",
		version: [4, 6],
		family: "claude-4.6",
		maxOutputTokens: 64_000,
		maxContextLength: 1_000_000,
		thinkingEffortLevels: ["off", "low", "medium", "high", "max"],
	},
	// Haiku 5.5 — 128k output, 1M context. Adaptive thinking is on by default
	// (default effort "medium"); unlike Sonnet/Opus 5.5 it accepts
	// `thinking: {type: "disabled"}` (at effort ≤ high), so "off" is offered.
	{
		tier: "haiku",
		version: [5, 5],
		family: "claude-5.5",
		maxOutputTokens: 128_000,
		maxContextLength: 1_000_000,
		thinkingEffortLevels: ["off", "low", "medium", "high", "xhigh", "max"],
	},
	// Haiku 4.5 — 64k output, 200k context (no effort support).
	{
		tier: "haiku",
		version: [4, 5],
		family: "claude-4.5",
		maxOutputTokens: 64_000,
		maxContextLength: 200_000,
	},
];

/**
 * Rules for ids with no tier entry at or below their version (Sonnet/Opus 4.5
 * and earlier) and for pre-tier shapes (`claude-3-5-sonnet-…`). First match
 * wins. `[-.]` accepts dash-style (Anthropic/Bedrock) and dot-style
 * (OpenRouter) version separators.
 */
const LEGACY_RULES: (ClaudeCapabilities & { match: RegExp })[] = [
	{ match: /^claude-\w+-4[-.]5/, family: "claude-4.5", maxOutputTokens: 16_000 },
	{ match: /^claude-\w+-4/, family: "claude-4", maxOutputTokens: 16_000 },
	{ match: /^claude-3/, family: "claude-3", maxOutputTokens: 8_192 },
];

/**
 * Tier and version of a modern id: `claude-opus-4-8`, `claude-sonnet-4.6`,
 * `claude-opus-4-8-v1:0`, `claude-opus-4-8@20260101`. The minor is at most two
 * digits, so a date (`claude-sonnet-5-20260724`) is never read as one.
 */
const MODERN_ID = /^claude-([a-z]+)-(\d+)(?:[-.](\d{1,2})(?!\d))?(?=$|[-@:.])/;

function compareVersions(a: readonly [number, number], b: readonly [number, number]): number {
	return a[0] - b[0] || a[1] - b[1];
}

/** The tier's entry with the greatest version at or below the id's own. */
function findTierEntry(normalizedId: string): TierEntry | undefined {
	const m = MODERN_ID.exec(normalizedId);
	if (!m) {
		return undefined;
	}
	const tier = m[1];
	const version: readonly [number, number] = [Number(m[2]), Number(m[3] ?? 0)];
	let best: TierEntry | undefined;
	for (const entry of TIER_ENTRIES) {
		if (
			entry.tier === tier &&
			compareVersions(entry.version, version) <= 0 &&
			(!best || compareVersions(entry.version, best.version) > 0)
		) {
			best = entry;
		}
	}
	return best;
}

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

	const rule: ClaudeCapabilities | undefined =
		findTierEntry(normalized) ?? LEGACY_RULES.find((r) => r.match.test(normalized));

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
