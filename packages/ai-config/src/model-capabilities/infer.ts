/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type {
	CompleteInferredModelCapabilities,
	InferredModelCapabilityResolution,
	InferredModelCapabilities,
} from "../types.js";
import type { Protocol } from "../vocabulary.js";
import { getAnthropicModelCapabilities } from "./anthropic-helpers.js";
import { getBedrockMantleModelCapabilities } from "./bedrock-mantle-helpers.js";
import { getDeepSeekModelCapabilities } from "./deepseek-helpers.js";
import { getGeminiApiModelCapabilities } from "./gemini-api-helpers.js";
import { getGeminiModelCapabilities } from "./gemini-helpers.js";
import {
	classifyLitellmModel,
	getLitellmModelCapabilities,
	type LitellmModelClassificationInput,
	type LitellmModelFamily,
} from "./litellm-helpers.js";
import { getOpenAIModelCapabilities, openaiMaxInputTokens } from "./openai-helpers.js";
import { getPortkeyModelCapabilities } from "./portkey-helpers.js";
import { getPositAiModelCapabilities } from "./positai-helpers.js";
import { getSnowflakeCortexModelCapabilities } from "./snowflake-cortex-helpers.js";

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

/** Provider-family inference: which capability table applies for this provider's ids. */
function familyDefaults(providerId: string, modelId: string): Partial<InferredModelCapabilities> {
	switch (providerId) {
		case "anthropic":
			return getAnthropicModelCapabilities(modelId) ?? {};
		case "bedrock":
			return (
				getBedrockMantleModelCapabilities(modelId) ?? getAnthropicModelCapabilities(modelId) ?? {}
			);
		case "openai": {
			const caps = getOpenAIModelCapabilities(modelId);
			if (!caps) return {};
			return { ...caps, maxInputTokens: openaiMaxInputTokens(caps) };
		}
		case "positai":
			return getPositAiModelCapabilities(modelId) ?? {};
		case "gemini":
			// The hosted Gemini API endpoint also serves Gemma models; the
			// endpoint composition layers hosted-Gemma rules over the shared
			// Gemini-family table.
			return getGeminiApiModelCapabilities(modelId) ?? {};
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
		case "litellm":
			// LiteLLM ids here are proxy aliases; a Claude-looking alias gets
			// Anthropic capabilities, anything else stays conservative.
			return getLitellmModelCapabilities(modelId) ?? {};
		case "portkey":
			// Portkey ids may carry a `@slug/` catalog prefix (stripped inside
			// the helper). Provisional Claude-or-conservative rule — see
			// portkey-helpers.ts (TODO(phase1)).
			return getPortkeyModelCapabilities(modelId) ?? {};
		case "snowflake-cortex":
			// Cortex serves a fixed catalog at its own token windows, which differ
			// from the upstream vendor limits; the shared table owns them.
			return getSnowflakeCortexModelCapabilities(modelId);
		default:
			// ms-foundry, openai-compatible, custom provider ids: unknown
			// endpoints, stay conservative.
			return {};
	}
}

/**
 * Apply the generic baseline plus a derivation the tables themselves omit:
 * image MIME types imply image support unless the table explicitly says
 * otherwise.
 *
 * Exported within the package so every profile helper (LiteLLM, Databricks, …)
 * completes capabilities the same way.
 */
export function completeCapabilities(
	caps: Partial<InferredModelCapabilities>,
): CompleteInferredModelCapabilities {
	const withDerivedImageSupport =
		caps.supportsImages === undefined &&
		caps.supportedInputMediaTypes?.some((mediaType) => mediaType.startsWith("image/"))
			? { ...caps, supportsImages: true }
			: caps;
	const { requiresChatTemplateKwargs: _drop, ...inferred } = withDerivedImageSupport;
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

export interface LitellmModelProfileInput extends LitellmModelClassificationInput {
	supportsReasoning?: boolean | null;
	supportsMinimalReasoningEffort?: boolean | null;
	supportsLowReasoningEffort?: boolean | null;
	supportsXhighReasoningEffort?: boolean | null;
	supportsMaxReasoningEffort?: boolean | null;
	useOpenAIResponsesPath?: boolean | null;
}

export interface LitellmModelProfile {
	family: LitellmModelFamily;
	protocol: Protocol;
	capabilities: CompleteInferredModelCapabilities;
}

function isOpenAIReasoningSeries(modelId: string): boolean {
	const bare = modelId.slice(modelId.lastIndexOf("/") + 1).toLowerCase();
	return /^o\d(?:$|[-.])/.test(bare);
}

function reasoningEffortLevels(
	input: LitellmModelProfileInput,
	knownLevels: string[] | undefined,
): string[] {
	const hasKnown = (level: string): boolean => knownLevels?.includes(level) === true;
	const supportsOptionalLevel = (
		signal: boolean | null | undefined,
		level: string,
		defaultWhenUnknown = false,
	): boolean => signal === true || (signal == null && (hasKnown(level) || defaultWhenUnknown));
	return [
		"off",
		...(supportsOptionalLevel(input.supportsMinimalReasoningEffort, "minimal") ? ["minimal"] : []),
		...(supportsOptionalLevel(input.supportsLowReasoningEffort, "low", knownLevels === undefined)
			? ["low"]
			: []),
		"medium",
		"high",
		...(supportsOptionalLevel(input.supportsXhighReasoningEffort, "xhigh") ? ["xhigh"] : []),
		...(supportsOptionalLevel(input.supportsMaxReasoningEffort, "max") ? ["max"] : []),
	];
}

/**
 * Resolve a LiteLLM discovery entry in one operation. Family-gating the
 * capability lookup here prevents non-OpenAI gateways with OpenAI-looking ids
 * from inheriting OpenAI reasoning controls. Live LiteLLM metadata is the
 * forward-compatible reasoning signal; the o-series namespace is a fallback
 * for proxies that omit model metadata.
 */
export function inferLitellmModelProfile(input: LitellmModelProfileInput): LitellmModelProfile {
	const classification = classifyLitellmModel(input);
	const knownCapabilities =
		classification.family === "other"
			? undefined
			: getLitellmModelCapabilities(classification.capabilityModelId);
	const isReasoningModel =
		classification.family === "openai" &&
		(input.supportsReasoning === true ||
			(input.supportsReasoning == null &&
				(knownCapabilities?.thinkingEffortLevels !== undefined ||
					isOpenAIReasoningSeries(classification.capabilityModelId))));
	const protocol: Protocol =
		classification.family === "claude"
			? "anthropic-messages"
			: classification.family === "openai" &&
				  (isReasoningModel || input.useOpenAIResponsesPath === true)
				? "openai-responses"
				: "openai-chat";
	const capabilities = isReasoningModel
		? {
				...knownCapabilities,
				thinkingEffortLevels: reasoningEffortLevels(input, knownCapabilities?.thinkingEffortLevels),
			}
		: (knownCapabilities ?? {});

	return {
		family: classification.family,
		protocol,
		capabilities: completeCapabilities(capabilities),
	};
}

/**
 * Infer both capability facts and an operational capability set for a model
 * known only by provider and id. `facts` preserves provider-family inference
 * before defaults; `operational` merges the generic baseline underneath it.
 * Completed operational fields also remain at top level for compatibility.
 *
 * Both public views exclude `requiresChatTemplateKwargs`: that flag is a
 * runtime request-shaping detail (it tells the vLLM client to send
 * `chat_template_kwargs`) and is re-derived from the model id at request time
 * by the bridge's positai path.
 */
export function inferModelCapabilities(
	providerId: string,
	modelId: string,
): InferredModelCapabilityResolution {
	const facts = familyDefaults(providerId, modelId);
	const { requiresChatTemplateKwargs: _drop, ...publicFacts } = facts;
	const operational = completeCapabilities(facts);
	return {
		...operational,
		facts: publicFacts,
		operational,
	};
}
