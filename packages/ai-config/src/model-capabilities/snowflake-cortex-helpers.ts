/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { InferredModelCapabilities } from "../types.js";
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
 * Static fallback list of Snowflake Cortex model ids: offered when model
 * discovery can't run `SHOW CORTEX BASE MODELS` (or it lists nothing usable),
 * and the set the Cortex rate card must price.
 *
 * Normally membership comes from that SQL query, filtered by
 * {@link isRecognizedSnowflakeCortexModel}. This list is the current-generation
 * Claude and OpenAI models (the only ones Cortex supports tool calling for)
 * from the Cortex **REST API** availability table — the endpoint
 * `SnowflakeClient` calls, which serves a different set than AI_COMPLETE —
 * GA or public preview, plus the GPT-5.6 line, which some accounts see only as
 * private preview. It is what Snowflake documents, not what a given account is
 * entitled to, so a listed model may still be refused.
 *
 * Display names come from {@link snowflakeCortexModelName}; capabilities from
 * {@link getSnowflakeCortexModelCapabilities}.
 *
 * https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-rest-api#model-availability
 */
export const SNOWFLAKE_CORTEX_CATALOG: readonly string[] = [
	// Claude — routed through the Anthropic Messages API.
	"claude-opus-5-5",
	"claude-sonnet-5-5",
	"claude-haiku-5-5",
	"claude-opus-5",
	"claude-sonnet-5",
	"claude-opus-4-8",
	// OpenAI — Chat Completions.
	"openai-gpt-6.1-sol",
	"openai-gpt-6-astra",
	"openai-gpt-6-sol",
	"openai-gpt-6-luna",
	"openai-gpt-5.6-sol",
	"openai-gpt-5.6-terra",
	"openai-gpt-5.6-luna",
];

/**
 * Display name for a Cortex model id: `claude-opus-4-8` → "Claude Opus 4.8",
 * `openai-gpt-6.1-sol` → "GPT-6.1 Sol". Short numeric segments after a number
 * join as a version; anything else is title-cased word by word.
 */
export function snowflakeCortexModelName(modelId: string): string {
	return modelId
		.replace(/^openai-/, "")
		.replace(/(?<=\d)-(?=\d{1,2}(?:-|$))/g, ".")
		.split("-")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ")
		.replace(/^Gpt /, "GPT-");
}

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

type UpstreamMatch =
	| {
			protocol: "anthropic-messages";
			upstream: Partial<InferredModelCapabilities>;
			recognized: boolean;
	  }
	| {
			protocol: "openai-chat";
			upstream: Partial<InferredModelCapabilities> | undefined;
			recognized: boolean;
	  };

/**
 * The upstream Anthropic/OpenAI table entry for a Cortex id, and whether the
 * table explicitly recognizes it. The Anthropic helper answers every
 * Claude-shaped id, supplying optimistic defaults when no rule matches, so
 * recognition there means a rule matched (signalled by `family`). Cortex
 * prefixes OpenAI ids with `openai-`, which the OpenAI table must not see.
 */
function upstreamCapabilities(modelId: string): UpstreamMatch {
	const claude = getAnthropicModelCapabilities(modelId);
	if (claude) {
		return {
			protocol: "anthropic-messages",
			upstream: claude,
			recognized: claude.family !== undefined,
		};
	}
	const openai = getOpenAIModelCapabilities(modelId.replace(/^openai-/, ""));
	return {
		protocol: "openai-chat",
		upstream: openai,
		recognized: modelId.startsWith("openai-") && openai !== undefined,
	};
}

/**
 * Whether the upstream Anthropic/OpenAI tables recognize a Cortex model id.
 * Model discovery lists only recognized models, so an unrecognized one
 * (Llama, Mistral, `openai-1p-*`, …) never appears in the picker.
 */
export function isRecognizedSnowflakeCortexModel(modelId: string): boolean {
	return upstreamCapabilities(modelId).recognized;
}

/**
 * Resolve the capabilities Snowflake Cortex serves a model with.
 *
 * The single source of truth for Cortex model metadata: the bridge reads
 * capabilities from here for every listed model, and inference for
 * user-configured Cortex models reads the same, so a listed model and a
 * `models.custom` override of the same id cannot disagree.
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
 * Accepts any model id, including unrecognized ones (see the fallbacks above),
 * so callers never have to handle an unknown-model case.
 */
export function getSnowflakeCortexModelCapabilities(
	modelId: string,
): SnowflakeCortexModelCapabilities {
	const match = upstreamCapabilities(modelId);
	if (match.protocol === "anthropic-messages") {
		const claude = match.upstream;
		const maxContextLength = claude.maxContextLength ?? CLAUDE_FALLBACK_CONTEXT_LENGTH;
		// Adopt the upstream output limit only for a recognized id: for others the
		// Anthropic helper supplies an optimistic 64k default, so take the
		// conservative fallback.
		const maxOutputTokens =
			match.recognized && claude.maxOutputTokens !== undefined
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

	const openai = match.upstream;
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
