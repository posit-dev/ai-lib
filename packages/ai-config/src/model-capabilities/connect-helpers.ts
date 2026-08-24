/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { getAnthropicModelCapabilities } from "./anthropic-helpers.js";

/**
 * Bedrock models offered through a Posit Connect gateway route. Declared
 * rather than discovered: Connect's Bedrock gateway proxies Bedrock *Runtime*
 * operations only and rejects ListFoundationModels/ListInferenceProfiles
 * (connect/src/connect/gateway/bedrock/provider.go), so live discovery would
 * have to bypass the gateway and hit AWS directly with Connect-minted
 * credentials.
 */
export const CONNECT_BEDROCK_MODEL_IDS: readonly string[] = [
	"us.anthropic.claude-sonnet-4-5-20250929-v1:0",
	"us.anthropic.claude-opus-4-1-20250805-v1:0",
	"us.anthropic.claude-3-5-haiku-20241022-v1:0",
];

/**
 * Context window and output cap for an id outside the Anthropic table — only
 * reachable via a user-configured override of the declared list. Deliberately
 * conservative: an under-reported cap wastes budget, an over-reported one
 * produces API errors.
 */
const FALLBACK_CONTEXT_LENGTH = 200_000;
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
 * which answers every `us.anthropic.*` id. Accepts any model id, so callers
 * never have to handle an unknown-model case (see the fallbacks above).
 */
export function getConnectBedrockModelCapabilities(
	modelId: string,
): ConnectBedrockModelCapabilities {
	const claude = getAnthropicModelCapabilities(modelId);
	const maxContextLength = claude?.maxContextLength ?? FALLBACK_CONTEXT_LENGTH;
	const maxOutputTokens = claude?.maxOutputTokens ?? FALLBACK_MAX_OUTPUT_TOKENS;
	return {
		family: claude?.family,
		thinkingEffortLevels: claude?.thinkingEffortLevels,
		maxContextLength,
		maxInputTokens: maxContextLength - maxOutputTokens,
		maxOutputTokens,
		supportsTools: true,
		supportsImages: true,
		supportsToolResultImages: true,
		supportedInputMediaTypes: claude?.supportedInputMediaTypes,
		supportsWebSearch: false,
	};
}
