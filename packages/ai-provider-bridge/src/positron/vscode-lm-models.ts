/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * VS Code Language Model discovery and mapping
 *
 * Provides vendor-to-provider mapping, model listing, and capability
 * enrichment for vscode.lm models.
 */

import * as vscode from "vscode";

import { getAnthropicModelCapabilities } from "../model-capabilities/anthropic-helpers";
import { getGeminiModelCapabilities } from "../model-capabilities/gemini-helpers";
import {
	getOpenAIModelCapabilities,
	openaiMaxInputTokens,
} from "../model-capabilities/openai-helpers";
import { MAPPED_PROVIDER_IDS, PROVIDER_MAP } from "../provider-map";
import type { ModelInfo, ProviderId } from "../types";
import { PROVIDER_IDS } from "../types";

// ============================================================================
// Provider ID utilities
// ============================================================================

/**
 * Type guard for provider IDs.
 * Provider-bridge owns PROVIDER_IDS, so this is the canonical implementation.
 */
export function isProviderId(value: string): value is ProviderId {
	return PROVIDER_IDS.some((id) => id === value);
}

// ============================================================================
// Vendor → Provider mapping
// ============================================================================

// Maps vscode.lm vendor strings and auth provider IDs to Posit Assistant logical
// provider IDs. Vendors that already match a ProviderId exactly (e.g.
// "copilot", "anthropic") are handled by isProviderId() and don't need
// entries here.
const VENDOR_TO_PROVIDER = new Map<string, ProviderId>([
	// vscode.lm vendor strings
	["amazon-bedrock", "bedrock"],
	["posit-ai", "positai"],
]);
// Also register auth provider IDs from PROVIDER_MAP (e.g. "anthropic-api" → "anthropic")
for (const logicalId of MAPPED_PROVIDER_IDS) {
	const mapping = PROVIDER_MAP[logicalId];
	if (!mapping) continue;
	VENDOR_TO_PROVIDER.set(mapping.authProviderId.toLowerCase(), logicalId);
}

/**
 * Map a vscode.lm vendor string to a ProviderId.
 *
 * Checks if the vendor string is itself a valid ProviderId first,
 * then falls back to the VENDOR_TO_PROVIDER mapping.
 *
 * @returns The ProviderId, or undefined if the vendor is not recognized.
 */
export function toProviderId(vendor: string): ProviderId | undefined {
	const normalizedVendor = vendor.toLowerCase();
	if (isProviderId(normalizedVendor)) {
		return normalizedVendor;
	}
	return VENDOR_TO_PROVIDER.get(normalizedVendor);
}

// ============================================================================
// Model capability inference
// ============================================================================

/**
 * Infer model capabilities from any model ID by delegating to
 * provider-specific capability functions.
 *
 * For OpenAI models, `maxInputTokens` is computed as
 * `maxContextLength - maxOutputTokens` since they share a context window.
 *
 * @returns A partial `ModelInfo` with token limits and capability flags,
 *          or `undefined` if the model ID is not recognized.
 */
function getModelCapabilities(modelId: string): Partial<ModelInfo> | undefined {
	const anthropic = getAnthropicModelCapabilities(modelId);
	if (anthropic) {
		return anthropic;
	}

	const gemini = getGeminiModelCapabilities(modelId);
	if (gemini) {
		return gemini;
	}

	const openai = getOpenAIModelCapabilities(modelId);
	if (openai) {
		const maxInputTokens = openaiMaxInputTokens(openai);
		return {
			...openai,
			maxInputTokens,
		};
	}

	return undefined;
}

// ============================================================================
// Model listing
// ============================================================================

export interface ListVscodeLmModelsOptions {
	/** Filter to specific provider IDs. If omitted, returns all recognized providers. */
	providerIds?: ProviderId[];
}

/**
 * List available vscode.lm models, enriched with capability information.
 *
 * Wraps `vscode.lm.selectChatModels()` with:
 * - Vendor → ProviderId mapping (skips unrecognized vendors)
 * - Optional ProviderId filtering
 * - Model capability enrichment from provider-specific helpers
 *
 * Note: this can reject. `vscode.lm.selectChatModels()` does not necessarily
 * return an empty list when a registered LM provider is unusable — a provider
 * can throw during model resolution (one plausible trigger is a Copilot LM
 * provider's entitlement check when the user is signed into GitHub without a
 * provisioned Copilot license). Callers must decide how to degrade (this leaf
 * has no logger and so cannot decide the failure policy); both current callers
 * catch and log, then fall back to an empty list so a broken vscode.lm source
 * does not suppress other model sources.
 *
 * @param options - Optional filtering options
 * @returns Array of ModelInfo for available models
 */
export async function listVscodeLmModels(
	options?: ListVscodeLmModelsOptions,
): Promise<ModelInfo[]> {
	const models = await vscode.lm.selectChatModels();
	const availableModels: ModelInfo[] = [];

	for (const model of models) {
		const providerId = toProviderId(model.vendor);
		if (!providerId) {
			continue;
		}
		if (options?.providerIds && !options.providerIds.includes(providerId)) {
			continue;
		}

		const caps = getModelCapabilities(model.id);
		availableModels.push({
			id: model.id,
			name: model.name,
			providerId,
			family: model.family,
			vendor: model.vendor,
			maxInputTokens: caps?.maxInputTokens ?? model.maxInputTokens,
			maxOutputTokens: caps?.maxOutputTokens, // Not available in VS Code API
			supportsTools: true,
			supportsImages: true,
			supportedInputMediaTypes: caps?.supportedInputMediaTypes,
			supportsToolResultImages: caps?.supportsToolResultImages ?? false,
			supportsWebSearch: false,
			maxContextLength: caps?.maxContextLength ?? (model.maxInputTokens || 100000),
		});
	}

	return availableModels;
}
