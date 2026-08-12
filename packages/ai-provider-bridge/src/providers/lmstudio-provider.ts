/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { LMSTUDIO_API_VERSION, LMSTUDIO_HOST } from "ai-config";
import type { ResolvedProviderId } from "ai-config";

import { LMStudioClient } from "../model-clients/LMStudioClient";
import type { Logger, ModelInfo } from "../types";
import type { LocalCredentials } from "../types";
import { joinPath, normalizeProviderBaseUrl } from "../utils";
import { createCachedModelFetcher } from "./cached-model-fetcher";
import type { ClientFactory, ProviderRegistry } from "./ProviderRegistry";

// Helper: Extract vendor from LM Studio model name
const extractVendorFromModelName = (name: string): string => {
	const modelBase = name.toLowerCase();

	if (modelBase.includes("llama")) return "meta";
	if (modelBase.includes("mistral")) return "mistralai";
	if (modelBase.includes("phi")) return "microsoft";
	if (modelBase.includes("gemma")) return "google";
	if (modelBase.includes("qwen")) return "alibaba";

	return "community";
};

// Helper: Format LM Studio model name for display
const formatLMStudioModelName = (name: string): string => {
	// Remove .gguf extension if present
	let displayName = name.replace(/\.gguf$/i, "");

	// Capitalize model name
	displayName = displayName
		.split(/[-_]/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");

	return displayName;
};

// Helper: Estimate context length from model name
const estimateContextLength = (name: string): number => {
	const n = name.toLowerCase();

	// Llama 3.1/3.2 has 128k context
	if (n.includes("llama3.1") || n.includes("llama3.2")) return 128000;

	// Llama 3 has 8k context
	if (n.includes("llama3")) return 8192;

	// Mistral models typically have 32k
	if (n.includes("mistral")) return 32000;

	// Phi has 4k
	if (n.includes("phi")) return 4096;

	// Gemma has 8k
	if (n.includes("gemma")) return 8192;

	// Default for unknown models
	return 4096;
};

// Static fallback models - conservative capabilities
const LMSTUDIO_FALLBACK: ModelInfo[] = [];

function createLMStudioModelFetcher(providerId: ResolvedProviderId, logger: Logger) {
	return createCachedModelFetcher<LocalCredentials>({
		providerId,
		resolveUrl: (credentials) => {
			// Endpoint already includes /v1 (bare default host corrected at the
			// config read seam); normalizeProviderBaseUrl only trims here.
			return joinPath(
				normalizeProviderBaseUrl(credentials.endpoint, LMSTUDIO_HOST, LMSTUDIO_API_VERSION),
				"models",
			);
		},
		hasCredentials: (credentials) => Boolean(credentials.endpoint),
		createHeaders: () => ({
			"Content-Type": "application/json",
		}),
		parseResponse: (data: unknown) => {
			const typedData = data as {
				data: Array<{
					id: string;
					object: string;
					owned_by: string;
					permission: Array<{
						id: string;
						object: string;
						created: number;
						allow_create_engine: boolean;
						allow_sampling: boolean;
						allow_logprobs: boolean;
						allow_search_indices: boolean;
						allow_view: boolean;
						allow_fine_tuning: boolean;
						organization: string;
						group_id: string | null;
						is_blocking: boolean;
					}>;
				}>;
			};

			return typedData.data.map((model) => ({
				id: model.id,
				name: formatLMStudioModelName(model.id),
				providerId,
				vendor: extractVendorFromModelName(model.id),
				family: undefined,
				maxInputTokens: estimateContextLength(model.id),
				maxOutputTokens: 2048,
				// LM Studio doesn't support tools or images
				supportsTools: false,
				supportsImages: false,
				supportsToolResultImages: false,
				supportsWebSearch: false,
				maxContextLength: estimateContextLength(model.id),
			}));
		},
		fallbackModels: LMSTUDIO_FALLBACK,
		logger,
		ttl: 5 * 60 * 1000, // 5 minutes
	});
}

const lmStudioClientFactory: ClientFactory = (credentials) => {
	if (credentials.type !== "local") {
		throw new Error(
			`LM Studio provider requires local endpoint credentials, got: ${credentials.type}`,
		);
	}
	return new LMStudioClient(credentials.endpoint);
};

export function registerLMStudioProvider(registry: ProviderRegistry, logger: Logger): void {
	registry.registerModelFetcher("lmstudio", createLMStudioModelFetcher("lmstudio", logger));
	registry.registerClientFactory("lmstudio", lmStudioClientFactory);
}

export function registerCustomLMStudioProvider(
	registry: ProviderRegistry,
	providerId: ResolvedProviderId,
	logger: Logger,
): void {
	registry.registerModelFetcher(providerId, createLMStudioModelFetcher(providerId, logger));
	registry.registerClientFactory("lmstudio", lmStudioClientFactory);
}
