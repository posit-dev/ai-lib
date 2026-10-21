/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { getAnthropicModelCapabilities } from "./anthropic-helpers.js";
import { getOpenAIModelCapabilities } from "./openai-helpers.js";

/**
 * Output-token fallback for an id the upstream Anthropic/OpenAI tables know
 * nothing about. Deliberately conservative, matching the Cortex REST API's
 * documented per-account default output limit: an under-reported cap wastes
 * output budget, an over-reported one produces
 * `400 max tokens of <count> exceeded`.
 *
 * https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-rest-api#rate-limits
 */
const FALLBACK_MAX_OUTPUT_TOKENS = 16_384;

/**
 * The models Posit Assistant offers on Snowflake Cortex.
 *
 * Membership follows the Cortex **REST API** availability table, which is the
 * endpoint `SnowflakeClient` calls and which serves a different (currently
 * smaller) set than the AI_COMPLETE SQL function does — selecting a model REST
 * does not serve fails with `400 unknown model`. Restricted further to Claude
 * and OpenAI models, the only ones Cortex supports tool calling for, current
 * generation, GA or public preview — plus the GPT-5.6 line, which some
 * accounts see only as private preview.
 *
 * This is the full set Snowflake documents, not what a given account is
 * entitled to. Model discovery in ai-provider-bridge narrows it per account
 * with `SHOW CORTEX BASE MODELS`, falling back to the full catalog when that
 * query can't run; the query only filters, since it carries no token limits
 * or tool support. A listed preview model may still be refused.
 *
 * The catalog decides membership only; context windows and output limits come
 * from the upstream Anthropic/OpenAI tables (see
 * `getSnowflakeCortexModelCapabilities`).
 *
 * https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-rest-api#model-availability
 */
export interface SnowflakeCortexCatalogEntry {
	/** Exact model id sent to Cortex. */
	readonly id: string;
	/** Display name. */
	readonly name: string;
}

export const SNOWFLAKE_CORTEX_CATALOG: readonly SnowflakeCortexCatalogEntry[] = [
	// Claude — routed through the Anthropic Messages API.
	{ id: "claude-opus-5-5", name: "Claude Opus 5.5" },
	{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
	{ id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
	{ id: "claude-opus-5", name: "Claude Opus 5" },
	{ id: "claude-sonnet-5", name: "Claude Sonnet 5" },
	{ id: "claude-opus-4-8", name: "Claude Opus 4.8" },
	// OpenAI — Chat Completions.
	{ id: "openai-gpt-6.1-sol", name: "GPT-6.1 Sol" },
	{ id: "openai-gpt-6-astra", name: "GPT-6 Astra" },
	{ id: "openai-gpt-6-sol", name: "GPT-6 Sol" },
	{ id: "openai-gpt-6-luna", name: "GPT-6 Luna" },
	{ id: "openai-gpt-5.6-sol", name: "GPT-5.6 Sol" },
	{ id: "openai-gpt-5.6-terra", name: "GPT-5.6 Terra" },
	{ id: "openai-gpt-5.6-luna", name: "GPT-5.6 Luna" },
];

/**
 * Context-window fallbacks for ids the upstream tables don't recognize — a
 * user-configured override, or a model Snowflake added before this table was
 * updated. Deliberately conservative: an under-reported window wastes context,
 * an over-reported one produces API errors.
 */
const CLAUDE_FALLBACK_CONTEXT_LENGTH = 200_000;
const OPENAI_FALLBACK_CONTEXT_LENGTH = 128_000;

const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/**
 * Capabilities of a model as served by Snowflake Cortex. Every field is resolved
 * — `family` and `thinkingEffortLevels` are `undefined` when the upstream table
 * knows nothing about the id, not absent.
 */
export interface SnowflakeCortexModelCapabilities {
	protocol: "anthropic-messages" | "openai-chat";
	family: string | undefined;
	thinkingEffortLevels: string[] | undefined;
	maxContextLength: number;
	maxInputTokens: number;
	maxOutputTokens: number;
	supportsTools: boolean;
	supportsImages: boolean;
	supportsToolResultImages: boolean;
	supportedInputMediaTypes: string[] | undefined;
	supportsWebSearch: false;
}

/**
 * Resolve the capabilities Snowflake Cortex serves a model with.
 *
 * The single source of truth for Cortex model metadata: the bridge builds its
 * static catalog from `SNOWFLAKE_CORTEX_CATALOG` and reads capabilities from
 * here, and inference for user-configured Cortex models reads the same, so a
 * catalog entry and a `models.custom` override of the same id cannot disagree.
 * Context windows, output limits, `family`, and thinking-effort levels come
 * from the upstream Anthropic/OpenAI tables, with conservative fallbacks for ids
 * upstream doesn't recognize; feature flags describe the REST endpoint. If
 * Cortex caps a window below upstream, requests that exceed it fail at the API.
 *
 * Claude models are routed through the Anthropic Messages API rather than Chat
 * Completions (Cortex offers both) for thinking, tool use, and images in tool
 * results. Everything else is Chat Completions only.
 *
 * Input and output share the context window, so `maxInputTokens` is the window
 * minus the output cap.
 *
 * Accepts any model id, including ones outside the catalog (see the fallbacks
 * above), so callers never have to handle an unknown-model case.
 */
export function getSnowflakeCortexModelCapabilities(
	modelId: string,
): SnowflakeCortexModelCapabilities {
	const claude = getAnthropicModelCapabilities(modelId);
	if (claude) {
		const maxContextLength = claude.maxContextLength ?? CLAUDE_FALLBACK_CONTEXT_LENGTH;
		// Adopt the upstream output limit only when an explicit capability rule
		// matched (signalled by `family`). The Anthropic helper answers every
		// Claude-shaped id, supplying its own optimistic 64k default when no
		// rule matches, so unrecognized ids take the conservative fallback.
		const maxOutputTokens =
			claude.family !== undefined && claude.maxOutputTokens !== undefined
				? claude.maxOutputTokens
				: FALLBACK_MAX_OUTPUT_TOKENS;
		return {
			protocol: "anthropic-messages",
			family: claude.family,
			thinkingEffortLevels: claude.thinkingEffortLevels,
			maxContextLength,
			maxInputTokens: maxContextLength - maxOutputTokens,
			maxOutputTokens,
			supportsTools: true,
			supportsImages: true,
			supportsToolResultImages: true,
			supportedInputMediaTypes: [...IMAGE_MEDIA_TYPES],
			supportsWebSearch: false,
		};
	}

	// Cortex prefixes OpenAI ids with `openai-`; the OpenAI table must not see it.
	const openai = getOpenAIModelCapabilities(modelId.replace(/^openai-/, ""));
	const maxContextLength = openai?.maxContextLength ?? OPENAI_FALLBACK_CONTEXT_LENGTH;
	const supportsImages =
		openai?.supportedInputMediaTypes?.some((mediaType) => mediaType.startsWith("image/")) ?? false;
	const maxOutputTokens = openai?.maxOutputTokens ?? FALLBACK_MAX_OUTPUT_TOKENS;
	return {
		protocol: "openai-chat",
		family: openai?.family,
		thinkingEffortLevels: openai?.thinkingEffortLevels,
		maxContextLength,
		maxInputTokens: maxContextLength - maxOutputTokens,
		maxOutputTokens,
		supportsTools: true,
		supportsImages,
		supportsToolResultImages: false,
		supportedInputMediaTypes: supportsImages ? [...IMAGE_MEDIA_TYPES] : undefined,
		supportsWebSearch: false,
	};
}
