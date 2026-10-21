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
	 * context window is a property of the model rather than of the endpoint. An
	 * id that table omits takes its family's Cortex figure, else the fallbacks
	 * below; never the upstream provider's window, which Cortex may cap.
	 */
	readonly maxContextLength: number;
}

export const SNOWFLAKE_CORTEX_CATALOG: readonly SnowflakeCortexCatalogEntry[] = [
	// Claude — routed through the Anthropic Messages API. AISQL publishes no
	// window for Sonnet or Haiku 5.5, so they take the 1M Cortex gives Opus 5.5.
	{ id: "claude-opus-5-5", name: "Claude Opus 5.5", maxContextLength: 1_000_000 },
	{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", maxContextLength: 1_000_000 },
	{ id: "claude-haiku-5-5", name: "Claude Haiku 5.5", maxContextLength: 1_000_000 },
	{ id: "claude-opus-5", name: "Claude Opus 5", maxContextLength: 1_000_000 },
	{ id: "claude-sonnet-5", name: "Claude Sonnet 5", maxContextLength: 1_000_000 },
	{ id: "claude-opus-4-8", name: "Claude Opus 4.8", maxContextLength: 1_000_000 },
	// OpenAI — Chat Completions. AISQL publishes no window for these ids. The
	// GPT-5.6 line takes the 272k Cortex gives the rest of the GPT-5 line; Cortex
	// publishes nothing for GPT-6, so it takes the 128k fallback below.
	{ id: "openai-gpt-6.1-sol", name: "GPT-6.1 Sol", maxContextLength: 128_000 },
	{ id: "openai-gpt-6-astra", name: "GPT-6 Astra", maxContextLength: 128_000 },
	{ id: "openai-gpt-6-sol", name: "GPT-6 Sol", maxContextLength: 128_000 },
	{ id: "openai-gpt-6-luna", name: "GPT-6 Luna", maxContextLength: 128_000 },
	{ id: "openai-gpt-5.6-sol", name: "GPT-5.6 Sol", maxContextLength: 272_000 },
	{ id: "openai-gpt-5.6-terra", name: "GPT-5.6 Terra", maxContextLength: 272_000 },
	{ id: "openai-gpt-5.6-luna", name: "GPT-5.6 Luna", maxContextLength: 272_000 },
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
 * An upstream output limit that fills Cortex's (smaller) window would leave no
 * room for input — e.g. GPT-5.x/6's 128k output against the 128k fallback
 * window — so such a limit drops to the conservative fallback.
 */
function fitOutputLimit(maxOutputTokens: number, maxContextLength: number): number {
	return maxOutputTokens >= maxContextLength ? FALLBACK_MAX_OUTPUT_TOKENS : maxOutputTokens;
}

/**
 * Resolve the capabilities Snowflake Cortex serves a model with.
 *
 * The single source of truth for Cortex model metadata: the bridge builds its
 * static catalog from `SNOWFLAKE_CORTEX_CATALOG` and reads capabilities from
 * here, and inference for user-configured Cortex models reads the same, so a
 * catalog entry and a `models.custom` override of the same id cannot disagree.
 * Windows and feature flags describe the REST endpoint; `family`,
 * thinking-effort levels, and (for ids an explicit upstream rule recognizes)
 * output limits are borrowed from the upstream Anthropic/OpenAI tables.
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
		// Adopt the upstream output limit only when an explicit capability rule
		// matched (signalled by `family`). The Anthropic helper answers every
		// Claude-shaped id, supplying its own optimistic 64k default when no
		// rule matches, so unrecognized ids take the conservative fallback.
		const maxOutputTokens = fitOutputLimit(
			claude.family !== undefined && claude.maxOutputTokens !== undefined
				? claude.maxOutputTokens
				: FALLBACK_MAX_OUTPUT_TOKENS,
			maxContextLength,
		);
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
	const maxContextLength =
		CATALOG_BY_ID.get(modelId)?.maxContextLength ?? OPENAI_FALLBACK_CONTEXT_LENGTH;
	const supportsImages =
		openai?.supportedInputMediaTypes?.some((mediaType) => mediaType.startsWith("image/")) ?? false;
	const maxOutputTokens = fitOutputLimit(
		openai?.maxOutputTokens ?? FALLBACK_MAX_OUTPUT_TOKENS,
		maxContextLength,
	);
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
