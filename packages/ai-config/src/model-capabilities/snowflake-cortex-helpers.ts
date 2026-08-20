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
 * and OpenAI models, the only ones Cortex supports tool calling for, and to
 * current model generations.
 *
 * Some entries are preview-only or need cross-region inference enabled, so an
 * individual account may still refuse one; the table is what Snowflake
 * documents, not what a given account is entitled to.
 *
 * https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-rest-api#model-availability
 */
export interface SnowflakeCortexCatalogEntry {
	/** Exact model id sent to Cortex. */
	readonly id: string;
	/** Display name. */
	readonly name: string;
	/**
	 * Total context window, input plus output. The REST docs publish no window
	 * per model, so these come from Cortex's AISQL model-restrictions table for
	 * the same model ids — the one figure worth borrowing from that page, since a
	 * context window is a property of the model rather than of the endpoint.
	 */
	readonly maxContextLength: number;
}

export const SNOWFLAKE_CORTEX_CATALOG: readonly SnowflakeCortexCatalogEntry[] = [
	// Claude — routed through the Anthropic Messages API.
	{ id: "claude-opus-5", name: "Claude Opus 5", maxContextLength: 1_000_000 },
	{ id: "claude-opus-4-7", name: "Claude Opus 4.7", maxContextLength: 1_000_000 },
	{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", maxContextLength: 1_000_000 },
	{ id: "claude-opus-4-6", name: "Claude Opus 4.6", maxContextLength: 1_000_000 },
	{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", maxContextLength: 200_000 },
	// OpenAI — Chat Completions. AISQL publishes no window for `openai-gpt-5.4`
	// (only its mini/nano variants, which REST does not serve), so it takes the
	// 272k window Cortex gives the rest of the GPT-5 line.
	{ id: "openai-gpt-5.4", name: "GPT-5.4", maxContextLength: 272_000 },
	{ id: "openai-gpt-5.2", name: "GPT-5.2", maxContextLength: 272_000 },
];

const CATALOG_BY_ID = new Map(SNOWFLAKE_CORTEX_CATALOG.map((entry) => [entry.id, entry]));

/**
 * Context window for an id outside the catalog — a user-configured override, or
 * a model Snowflake added before this table was updated. Claude ids get the
 * smallest window Cortex serves a Claude model with; anything else the generic
 * Chat Completions floor. Deliberately conservative: an under-reported window
 * wastes context, an over-reported one produces API errors.
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
 * Windows and feature flags describe the REST endpoint; only `family` and
 * thinking-effort levels are borrowed from the upstream Anthropic/OpenAI tables.
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
		const maxContextLength =
			CATALOG_BY_ID.get(modelId)?.maxContextLength ?? CLAUDE_FALLBACK_CONTEXT_LENGTH;
		return {
			protocol: "anthropic-messages",
			family: claude.family,
			thinkingEffortLevels: claude.thinkingEffortLevels,
			maxContextLength,
			maxInputTokens: maxContextLength - claude.maxOutputTokens,
			maxOutputTokens: claude.maxOutputTokens,
			supportsTools: true,
			supportsImages: true,
			supportsToolResultImages: true,
			supportedInputMediaTypes: [...IMAGE_MEDIA_TYPES],
			supportsWebSearch: false,
		};
	}

	// Cortex prefixes OpenAI ids with `openai-`; the OpenAI table must not see it.
	const openai = getOpenAIModelCapabilities(modelId.replace(/^openai-/, ""));
	const maxContextLength =
		CATALOG_BY_ID.get(modelId)?.maxContextLength ?? OPENAI_FALLBACK_CONTEXT_LENGTH;
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
