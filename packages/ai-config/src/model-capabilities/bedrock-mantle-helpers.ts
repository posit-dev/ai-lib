/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { InferredModelCapabilities } from "../types.js";

const GPT_OSS_EFFORT_LEVELS = ["low", "medium", "high"];
const GPT_5_EFFORT_LEVELS = ["off", "low", "medium", "high", "xhigh"];
const GPT_6_EFFORT_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"];
// Astra has no "none" effort level; Mantle maps "off" to the wire value
// "none", so Astra's list omits "off".
const GPT_6_ASTRA_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"];

/**
 * Capabilities for OpenAI models served through Bedrock Mantle.
 *
 * Safeguard models are deliberately excluded: they are moderation models, not
 * chat models. Unknown IDs are also excluded instead of receiving guessed
 * capabilities.
 */
export function getBedrockMantleModelCapabilities(
	modelId: string,
): InferredModelCapabilities | undefined {
	if (modelId.startsWith("openai.gpt-oss-") && !modelId.includes("-safeguard-")) {
		return {
			protocol: "openai-chat",
			family: "gpt-oss",
			maxContextLength: 128_000,
			maxInputTokens: 112_000,
			maxOutputTokens: 16_384,
			supportsTools: true,
			supportsImages: false,
			supportsToolResultImages: false,
			supportsWebSearch: false,
			thinkingEffortLevels: GPT_OSS_EFFORT_LEVELS,
		};
	}

	// Sources verified 2026-09-22:
	// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-astra.html
	// The Astra model card documents the 1.05M window and 128K output ceiling,
	// so both are set here (unlike GPT-5.6, whose output ceiling AWS does not
	// publish).
	if (/^openai\.gpt-6-astra(?:-\d{4}-\d{2}-\d{2})?$/.test(modelId)) {
		return {
			protocol: "openai-responses",
			family: "gpt-6",
			maxContextLength: 1_050_000,
			maxOutputTokens: 128_000,
			supportsTools: true,
			supportsImages: true,
			supportedInputMediaTypes: IMAGE_MEDIA_TYPES,
			supportsToolResultImages: true,
			supportsWebSearch: false,
			thinkingEffortLevels: GPT_6_ASTRA_EFFORT_LEVELS,
		};
	}

	// Unknown future GPT-6 IDs default to the 1M window; only the documented
	// Astra variants above get the published output ceiling.
	if (modelId.startsWith("openai.gpt-6")) {
		return {
			protocol: "openai-responses",
			family: "gpt-6",
			maxContextLength: 1_000_000,
			supportsTools: true,
			supportsImages: true,
			supportedInputMediaTypes: IMAGE_MEDIA_TYPES,
			supportsToolResultImages: true,
			supportsWebSearch: false,
			thinkingEffortLevels: GPT_6_EFFORT_LEVELS,
		};
	}

	// Sources verified 2026-09-02:
	// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-sol.html
	// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-terra.html
	// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-luna.html
	// Match only the documented GPT-5.6 production variants. Known older
	// releases are pinned below; unknown future GPT-5.x IDs default to the
	// family's 1M window.
	if (/^openai\.gpt-5\.6(?:-(?:sol|terra|luna)(?:-\d{4}-\d{2}-\d{2})?)?$/.test(modelId)) {
		return {
			protocol: "openai-responses",
			family: "gpt-5",
			maxContextLength: 1_000_000,
			// AWS does not publish a common GPT-5.x output ceiling. Leaving this
			// unset avoids inventing a family-wide limit.
			supportsTools: true,
			supportsImages: true,
			supportedInputMediaTypes: IMAGE_MEDIA_TYPES,
			supportsToolResultImages: true,
			supportsWebSearch: false,
			// Verified family-wide on 2026-07-28. "off" maps to wire value "none".
			thinkingEffortLevels: GPT_5_EFFORT_LEVELS,
		};
	}

	// GPT-5.4 and GPT-5.5 are known older releases; keep their long-standing
	// 272K value rather than extending the optimistic 1M default to them.
	if (/^openai\.gpt-5\.[45](?:-|$)/.test(modelId)) {
		return {
			protocol: "openai-responses",
			family: "gpt-5",
			maxContextLength: 272_000,
			supportsTools: true,
			supportsImages: true,
			supportedInputMediaTypes: IMAGE_MEDIA_TYPES,
			supportsToolResultImages: true,
			supportsWebSearch: false,
			thinkingEffortLevels: GPT_5_EFFORT_LEVELS,
		};
	}

	// Unknown future GPT-5.x IDs default to the 1M window documented for the
	// family's current generation (see the GPT-5.6 sources above).
	if (modelId.startsWith("openai.gpt-5.")) {
		return {
			protocol: "openai-responses",
			family: "gpt-5",
			maxContextLength: 1_000_000,
			supportsTools: true,
			supportsImages: true,
			supportedInputMediaTypes: IMAGE_MEDIA_TYPES,
			supportsToolResultImages: true,
			supportsWebSearch: false,
			thinkingEffortLevels: GPT_5_EFFORT_LEVELS,
		};
	}

	return undefined;
}
