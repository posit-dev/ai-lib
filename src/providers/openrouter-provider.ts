/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { getAnthropicModelCapabilities } from "../model-capabilities/anthropic-helpers";
import { OpenRouterClient } from "../model-clients/OpenRouterClient";
import type { Logger, ModelInfo } from "../types";
import type { ApiKeyCredentials } from "../types";
import { createCachedModelFetcher } from "./cached-model-fetcher";
import type { ProviderRegistry } from "./ProviderRegistry";

// OpenRouter API response types
interface OpenRouterModel {
	id: string;
	name: string;
	description?: string;
	context_length: number;
	pricing: {
		prompt: string; // Price per token as string (e.g., "0.00001")
		completion: string;
	};
	top_provider?: {
		max_completion_tokens?: number;
	};
	architecture?: {
		modality: string; // e.g., "text->text", "text+image->text"
		tokenizer: string;
		instruct_type?: string;
	};
	supported_parameters?: string[];
}

interface OpenRouterModelsResponse {
	data: OpenRouterModel[];
}

// Extract vendor from OpenRouter model ID (format: vendor/model-name)
const extractVendor = (modelId: string): string => {
	const slashIndex = modelId.indexOf("/");
	if (slashIndex > 0) {
		return modelId.substring(0, slashIndex);
	}
	return "unknown";
};

// Check if model supports vision based on architecture modality
const supportsVision = (model: OpenRouterModel): boolean => {
	const modality = model.architecture?.modality || "";
	return modality.includes("image");
};

// Static fallback models - popular models available on OpenRouter
const OPENROUTER_FALLBACK: ModelInfo[] = [];

/** Exported for testing. */
export function parseOpenRouterModels(data: unknown): ModelInfo[] {
	const typedData = data as OpenRouterModelsResponse;

	// Filter to models that support text generation (exclude embedding-only models)
	const chatModels = typedData.data.filter((model) => {
		const modality = model.architecture?.modality || "";
		return modality.includes("->text") || modality === "";
	});

	return chatModels.map((model) => {
		const vendor = extractVendor(model.id);
		const hasVision = supportsVision(model);
		const maxOutputTokens = model.top_provider?.max_completion_tokens || 4096;
		const params = model.supported_parameters ?? [];

		// Only use vendor helpers for family inference — not for token
		// limits, tool support, or thinking levels. OpenRouter's own
		// metadata and supported_parameters are authoritative.
		const anthropicCaps = getAnthropicModelCapabilities(model.id);

		const supportsReasoning = params.includes("reasoning");

		return {
			id: model.id,
			name: model.name,
			providerId: "openrouter",
			vendor,
			family: anthropicCaps?.family,
			supportsTools: params.includes("tools"),
			supportsImages: hasVision,
			supportsToolResultImages: hasVision,
			supportedInputMediaTypes: hasVision
				? ["image/png", "image/jpeg", "image/gif", "image/webp"]
				: undefined,
			maxContextLength: model.context_length,
			maxInputTokens: model.context_length,
			maxOutputTokens,
			thinkingEffortLevels: supportsReasoning ? ["off", "low", "medium", "high"] : undefined,
			supportsWebSearch: false,
		};
	});
}

export function registerOpenRouterProvider(registry: ProviderRegistry, logger: Logger): void {
	// Register model fetcher using cached utility
	registry.registerModelFetcher(
		"openrouter",
		createCachedModelFetcher<ApiKeyCredentials>({
			providerId: "openrouter",
			apiUrl: "https://openrouter.ai/api/v1/models",
			hasCredentials: (credentials) => Boolean(credentials.apiKey),
			createHeaders: (credentials) => ({
				Authorization: `Bearer ${credentials.apiKey}`,
			}),
			parseResponse: parseOpenRouterModels,
			fallbackModels: OPENROUTER_FALLBACK,
			logger,
			ttl: 30 * 60 * 1000, // 30 minutes - OpenRouter model list changes occasionally
		}),
	);

	// Register client factory
	registry.registerClientFactory("openrouter", (credentials) => {
		if (credentials.type !== "apikey") {
			throw new Error(`OpenRouter provider requires API key credentials, got: ${credentials.type}`);
		}
		return new OpenRouterClient(credentials.apiKey, credentials.customHeaders);
	});
}
