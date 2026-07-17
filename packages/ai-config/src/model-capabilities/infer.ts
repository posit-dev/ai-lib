/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { InferredModelCapabilities } from "../types.js";
import { getAnthropicModelCapabilities } from "./anthropic-helpers.js";
import { getDeepSeekModelCapabilities } from "./deepseek-helpers.js";
import { getGeminiModelCapabilities } from "./gemini-helpers.js";
import { getOpenAIModelCapabilities, openaiMaxInputTokens } from "./openai-helpers.js";
import { getPositAiModelCapabilities } from "./positai-helpers.js";

/**
 * Safe conservative baseline: enough that a text-only chat works with any
 * provider that accepts the id. Mirrors the assistant's GENERIC_BASELINE
 * (packages/positron/src/utils/model-override.ts), which this function
 * replaces as the shared home of the inference chain.
 */
const GENERIC_BASELINE = {
	supportsTools: true,
	supportsImages: false,
	supportsToolResultImages: false,
	supportsWebSearch: false,
	maxInputTokens: 128_000,
	maxOutputTokens: 16_384,
	maxContextLength: 128_000,
} as const;

const SNOWFLAKE_IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/**
 * Snowflake Cortex serves a fixed catalog with its own caps, not the upstream
 * model limits: Claude routes through the Anthropic Messages API (200k context
 * / 16k output), everything else through Chat Completions (128k / 16k). Only
 * `family` and thinking levels are borrowed from the upstream tables; token
 * windows and feature flags follow snowflake-cortex-provider.ts. Snowflake
 * OpenAI ids may carry an `openai-` prefix the OpenAI lookup must not see.
 */
function snowflakeDefaults(modelId: string): Partial<InferredModelCapabilities> {
	const claude = getAnthropicModelCapabilities(modelId);
	if (claude) {
		return {
			family: claude.family,
			thinkingEffortLevels: claude.thinkingEffortLevels,
			protocol: "anthropic-messages",
			maxContextLength: 200_000,
			maxInputTokens: 200_000,
			maxOutputTokens: 16_384,
			supportsTools: true,
			supportsImages: true,
			supportsToolResultImages: true,
			supportedInputMediaTypes: SNOWFLAKE_IMAGE_MEDIA_TYPES,
		};
	}
	const openai = getOpenAIModelCapabilities(modelId.replace(/^openai-/, ""));
	const supportsImages =
		openai?.supportedInputMediaTypes?.some((mediaType) => mediaType.startsWith("image/")) ?? false;
	return {
		family: openai?.family,
		thinkingEffortLevels: openai?.thinkingEffortLevels,
		protocol: "openai-chat",
		maxContextLength: 128_000,
		maxInputTokens: 128_000,
		maxOutputTokens: 16_384,
		supportsTools: true,
		supportsImages,
		supportsToolResultImages: false,
		supportedInputMediaTypes: supportsImages ? SNOWFLAKE_IMAGE_MEDIA_TYPES : undefined,
	};
}

/** Provider-family inference: which capability table applies for this provider's ids. */
function familyDefaults(providerId: string, modelId: string): Partial<InferredModelCapabilities> {
	switch (providerId) {
		case "anthropic":
		case "bedrock":
			return getAnthropicModelCapabilities(modelId) ?? {};
		case "openai": {
			const caps = getOpenAIModelCapabilities(modelId);
			if (!caps) return {};
			return { ...caps, maxInputTokens: openaiMaxInputTokens(caps) };
		}
		case "positai":
			return getPositAiModelCapabilities(modelId) ?? {};
		case "gemini":
			return getGeminiModelCapabilities(modelId) ?? {};
		case "google-vertex": {
			// Vertex ids may be resource names (`publishers/google/models/...`).
			// Gemini ids route to the Gemini table; Anthropic partner models to
			// the Anthropic table (mirrors google-vertex-provider.ts).
			const bare = modelId.replace(/^publishers\/[^/]+\/models\//, "");
			return getGeminiModelCapabilities(bare) ?? getAnthropicModelCapabilities(bare) ?? {};
		}
		case "deepseek": {
			const caps = getDeepSeekModelCapabilities(modelId);
			return {
				family: caps.family,
				maxInputTokens: caps.maxInputTokens,
				maxOutputTokens: caps.maxOutputTokens,
				// DeepSeek publishes no separate context-window figure; the bridge's
				// provider treats the input limit as the window (deepseek-provider.ts).
				maxContextLength: caps.maxInputTokens,
				supportsTools: caps.supportsTools,
				supportsImages: caps.supportsImages,
				thinkingEffortLevels: caps.thinkingEffortLevels,
			};
		}
		case "snowflake-cortex":
			return snowflakeDefaults(modelId);
		default:
			// ms-foundry, openai-compatible, custom provider ids: unknown
			// endpoints, stay conservative.
			return {};
	}
}

/**
 * Family inference plus a derivation the tables themselves omit: the
 * anthropic/gemini tables list image input MIME types but never set
 * `supportsImages`, so without this the baseline `false` would win for models
 * that plainly accept images. Explicit table values (e.g. gpt-3.5's
 * `supportsImages: false`) are never overridden.
 */
function inferProviderDefaults(
	providerId: string,
	modelId: string,
): Partial<InferredModelCapabilities> {
	const caps = familyDefaults(providerId, modelId);
	if (
		caps.supportsImages === undefined &&
		caps.supportedInputMediaTypes?.some((mediaType) => mediaType.startsWith("image/"))
	) {
		return { ...caps, supportsImages: true };
	}
	return caps;
}

/**
 * Infer a complete capability set for a model known only by provider and id:
 * the generic baseline merged under provider-family inference (inference wins
 * per field). Every required capability field is always present; optional
 * fields (family, media types, thinking levels, protocol) appear only when
 * inference determined them.
 *
 * The result is shaped to spread directly into a `models.custom` entry, so it
 * excludes `requiresChatTemplateKwargs`: that flag is a runtime request-shaping
 * detail (it tells the vLLM client to send `chat_template_kwargs`), re-derived
 * from the model id at request time by the bridge's positai path, and it is not
 * a field the strict `customModelSchema` accepts. The capability tables still
 * carry it for that runtime use; it is dropped only here, at the migration seam.
 */
export function inferModelCapabilities(
	providerId: string,
	modelId: string,
): Omit<InferredModelCapabilities, "requiresChatTemplateKwargs"> {
	const { requiresChatTemplateKwargs: _drop, ...inferred } = inferProviderDefaults(
		providerId,
		modelId,
	);
	// `??` per required field (not a bare spread) so a helper that explicitly
	// sets a field to `undefined` cannot shadow the baseline.
	return {
		...inferred,
		maxContextLength: inferred.maxContextLength ?? GENERIC_BASELINE.maxContextLength,
		maxInputTokens: inferred.maxInputTokens ?? GENERIC_BASELINE.maxInputTokens,
		maxOutputTokens: inferred.maxOutputTokens ?? GENERIC_BASELINE.maxOutputTokens,
		supportsTools: inferred.supportsTools ?? GENERIC_BASELINE.supportsTools,
		supportsImages: inferred.supportsImages ?? GENERIC_BASELINE.supportsImages,
		supportsToolResultImages:
			inferred.supportsToolResultImages ?? GENERIC_BASELINE.supportsToolResultImages,
		supportsWebSearch: inferred.supportsWebSearch ?? GENERIC_BASELINE.supportsWebSearch,
	};
}
