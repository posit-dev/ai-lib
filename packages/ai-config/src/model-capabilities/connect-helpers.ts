/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { getAnthropicModelCapabilities } from "./anthropic-helpers.js";
import {
	BEDROCK_FALLBACK_CONTEXT_LENGTH,
	getBedrockConverseMediaSupport,
} from "./bedrock-defaults.js";

/**
 * Output cap for an id outside the Anthropic table, such as a non-Claude model
 * the gateway lists. Deliberately conservative: an under-reported cap wastes
 * budget, an over-reported one produces API errors. The context window falls
 * back to {@link BEDROCK_FALLBACK_CONTEXT_LENGTH}.
 */
const FALLBACK_MAX_OUTPUT_TOKENS = 4_096;

/**
 * Capabilities of a Bedrock model served through a Connect gateway route.
 * Every field is resolved — `family`, `thinkingEffortLevels`, and
 * `supportedInputMediaTypes` are `undefined` when the Anthropic table knows
 * nothing about the id, not absent.
 */
export interface ConnectBedrockModelCapabilities {
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
 * Resolve the capabilities a Connect Bedrock gateway serves a model with.
 *
 * Tool/image/web-search flags mirror the bridge's own live-discovery defaults
 * for Anthropic-on-Bedrock models (bedrock-provider.ts); token limits, family,
 * thinking levels, and media types come from the Anthropic-on-Bedrock table,
 * which answers every Claude id. Accepts any model id, so callers never have
 * to handle an unknown-model case (see the fallbacks above). Image flags
 * follow the vendor as in the direct provider, so non-Claude Amazon models
 * (Nova) accept images and other vendors do not.
 */
export function getConnectBedrockModelCapabilities(
	modelId: string,
	vendor: string,
): ConnectBedrockModelCapabilities {
	const claude = getAnthropicModelCapabilities(modelId);
	const media = getBedrockConverseMediaSupport(vendor);
	const maxContextLength = claude?.maxContextLength ?? BEDROCK_FALLBACK_CONTEXT_LENGTH;
	const maxOutputTokens = claude?.maxOutputTokens ?? FALLBACK_MAX_OUTPUT_TOKENS;
	return {
		family: claude?.family,
		thinkingEffortLevels: claude?.thinkingEffortLevels,
		maxContextLength,
		maxInputTokens: maxContextLength - maxOutputTokens,
		maxOutputTokens,
		supportsTools: true,
		supportsImages: media.supportsImages,
		supportsToolResultImages: media.supportsToolResultImages,
		supportedInputMediaTypes: claude?.supportedInputMediaTypes ?? media.supportedInputMediaTypes,
		supportsWebSearch: false,
	};
}
