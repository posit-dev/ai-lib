/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { InferredModelCapabilities } from "../types.js";
import { getGpt6ModelProfile } from "./gpt6-model-profile.js";

const OPENAI_NAMESPACE = "openai.";
const GPT_OSS_EFFORT_LEVELS = ["low", "medium", "high"];
const GPT_5_EFFORT_LEVELS = ["off", "low", "medium", "high", "xhigh"];
const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"];
const ASTRA_PUBLISHED_LIMITS_ID = /^openai\.gpt-6-astra(?:-\d{4}-\d{2}-\d{2})?$/;

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

	// Model traits, including which GPT-6 models lack "off", are shared with
	// OpenAI (gpt6-model-profile.ts); capacity and routing are Bedrock's own.
	const gpt6 = modelId.startsWith(OPENAI_NAMESPACE)
		? getGpt6ModelProfile(modelId.slice(OPENAI_NAMESPACE.length))
		: undefined;
	if (gpt6) {
		// Sources verified 2026-09-22:
		// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-astra.html
		// The Astra model card documents the 1.05M window and 128K output
		// ceiling (unlike GPT-5.6, whose output ceiling AWS does not publish).
		// Reasoning follows model identity, but limits follow the exact ID:
		// only bare and dated Astra IDs get those limits. Other and unknown
		// future GPT-6 IDs default to the 1M window with no output ceiling,
		// even when they share Astra's reasoning rule.
		const limits = ASTRA_PUBLISHED_LIMITS_ID.test(modelId)
			? { maxContextLength: 1_050_000, maxOutputTokens: 128_000 }
			: { maxContextLength: 1_000_000 };
		return {
			...gpt6,
			...limits,
			protocol: "openai-responses",
			supportsWebSearch: false,
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
			// AWS documents Mantle-hosted web search for the GPT-5.4/5.5/5.6
			// families on the Responses route. This is the intrinsic family
			// rule; region, FIPS, and routing gates are applied later, at
			// capability finalization (see model-capabilities/web-search.ts).
			supportsWebSearch: true,
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
			// Documented Mantle web-search family (see the GPT-5.6 note above).
			supportsWebSearch: true,
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
