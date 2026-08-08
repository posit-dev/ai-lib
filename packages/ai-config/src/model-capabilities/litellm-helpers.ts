/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Capability inference and family classification for models served through a
 * LiteLLM proxy.
 *
 * A LiteLLM alias can front any upstream. Posit Assistant routes each alias
 * over its natural wire protocol against the same gateway — Anthropic-shaped
 * `/v1/messages` for Claude families, OpenAI-shaped `/v1/responses` /
 * `/v1/chat/completions` for everything else — so capabilities follow the
 * upstream family:
 *
 * - Claude models (direct Anthropic, Bedrock, Vertex) keep full Anthropic
 *   capabilities — explicit prompt caching and thinking-signature round-trips
 *   survive on the native `/v1/messages` route.
 * - Recognized OpenAI models get the OpenAI capability table, including
 *   `thinkingEffortLevels` for reasoning models: LiteLLM's `/v1/responses`
 *   preserves the stateless `store: false` encrypted-reasoning round-trip our
 *   OpenAI client uses (verified empirically against LiteLLM 1.95.0).
 * - Everything else (Gemini, local models, …) stays conservative.
 *
 * `classifyLitellmModel` is the single source of truth for "what is this
 * alias": the bridge's fetcher consumes it for protocol stamping and vendor
 * labeling, and feeds its `capabilityModelId` back into
 * `inferModelCapabilities("litellm", …)`, whose litellm branch calls
 * `getLitellmModelCapabilities` — keeping family detection and capability
 * inference in agreement.
 */

import type { InferredModelCapabilities } from "../types.js";
import { getAnthropicModelCapabilities } from "./anthropic-helpers.js";
import { getOpenAIModelCapabilities, openaiMaxInputTokens } from "./openai-helpers.js";

/** Upstream family of a LiteLLM alias, as far as routing is concerned. */
export type LitellmModelFamily = "claude" | "openai" | "other";

export interface LitellmModelClassification {
	family: LitellmModelFamily;
	/**
	 * The id to feed into `inferModelCapabilities("litellm", …)`: the
	 * underlying model id when it identified the family, otherwise the alias.
	 */
	capabilityModelId: string;
}

/**
 * `litellm_provider` values that name an OpenAI upstream (Azure OpenAI serves
 * the same models under the same ids).
 */
const OPENAI_LITELLM_PROVIDERS = new Set(["openai", "azure"]);

/** The `<provider>` segment of a LiteLLM underlying id like `openai/gpt-5-mini`. */
function underlyingProviderPrefix(underlyingModel: string): string | undefined {
	const slash = underlyingModel.indexOf("/");
	return slash === -1 ? undefined : underlyingModel.slice(0, slash);
}

/** The bare model portion after the last `/` (`vertex_ai/claude-x` → `claude-x`). */
function bareModelId(modelId: string): string {
	const slash = modelId.lastIndexOf("/");
	return slash === -1 ? modelId : modelId.slice(slash + 1);
}

function isClaudeId(modelId: string): boolean {
	return (
		getAnthropicModelCapabilities(modelId) !== undefined ||
		getAnthropicModelCapabilities(bareModelId(modelId)) !== undefined
	);
}

function isOpenAIId(modelId: string): boolean {
	return (
		getOpenAIModelCapabilities(modelId) !== undefined ||
		getOpenAIModelCapabilities(bareModelId(modelId)) !== undefined
	);
}

/**
 * Classify a LiteLLM alias by upstream family.
 *
 * The underlying model id (`litellm_params.model`) is the trusted signal — it
 * is what the proxy actually calls. The alias is consulted only when the
 * entry carries no underlying id at all (some proxies omit `litellm_params`;
 * admins there conventionally alias by the real model name). An alias that
 * merely *looks* like a known model while the underlying id says otherwise
 * (e.g. alias `gpt-4o` fronting a Gemini upstream) is deliberately classified
 * by the underlying id, not the alias.
 *
 * OpenAI classification additionally requires the provider signal
 * (`model_info.litellm_provider` or the underlying id's `<provider>/` prefix,
 * when either is present) to name an OpenAI upstream, so a non-OpenAI
 * provider serving an OpenAI-looking id is not routed as OpenAI.
 */
export function classifyLitellmModel(input: {
	alias: string;
	underlyingModel?: string | null;
	litellmProvider?: string | null;
}): LitellmModelClassification {
	const underlying = input.underlyingModel ?? "";

	if (underlying) {
		if (isClaudeId(underlying)) {
			return { family: "claude", capabilityModelId: underlying };
		}
		const prefix = underlyingProviderPrefix(underlying);
		const providerSignals = [input.litellmProvider, prefix].filter(
			(signal): signal is string => typeof signal === "string" && signal.length > 0,
		);
		const providerIsOpenAI =
			providerSignals.length === 0 || providerSignals.some((s) => OPENAI_LITELLM_PROVIDERS.has(s));
		if (providerIsOpenAI && isOpenAIId(underlying)) {
			return { family: "openai", capabilityModelId: underlying };
		}
		return { family: "other", capabilityModelId: underlying };
	}

	// No underlying id: the alias is the only signal.
	if (isClaudeId(input.alias)) {
		return { family: "claude", capabilityModelId: input.alias };
	}
	if (isOpenAIId(input.alias)) {
		return { family: "openai", capabilityModelId: input.alias };
	}
	return { family: "other", capabilityModelId: input.alias };
}

/**
 * Infer capabilities for a LiteLLM-served model from its underlying model id
 * (`litellm_params.model` in `/v1/model/info`, e.g. `anthropic/claude-opus-5`,
 * `bedrock/us.anthropic.claude-sonnet-4-6-...-v1:0`, `openai/gpt-5-mini`) or,
 * failing that, from a recognizable alias.
 *
 * @returns Anthropic capabilities for Claude-family models, OpenAI
 *          capabilities (with the input-token reservation applied) for
 *          recognized OpenAI models, or `undefined` for everything else
 *          (callers apply conservative defaults).
 */
export function getLitellmModelCapabilities(
	modelId: string,
): Partial<InferredModelCapabilities> | undefined {
	// LiteLLM underlying ids are `<provider>/<model>`. Some providers list
	// models without a recognizable provider segment (e.g.
	// `vertex_ai/claude-sonnet-4@20250514`), which the normalizers don't
	// recognize — retry with the bare model portion.
	const anthropic =
		getAnthropicModelCapabilities(modelId) ?? getAnthropicModelCapabilities(bareModelId(modelId));
	if (anthropic) {
		return anthropic;
	}
	const openai =
		getOpenAIModelCapabilities(modelId) ?? getOpenAIModelCapabilities(bareModelId(modelId));
	if (openai) {
		return { ...openai, maxInputTokens: openaiMaxInputTokens(openai) };
	}
	return undefined;
}
