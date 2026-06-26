/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { OllamaClient } from "../model-clients/OllamaClient";
import type { Logger, ModelInfo } from "../types";
import type { LocalCredentials } from "../types";
import { joinPath } from "../utils";
import { createCachedModelFetcher } from "./cached-model-fetcher";
import type { ProviderRegistry } from "./ProviderRegistry";

// Helper: Extract vendor from Ollama model name
const extractVendorFromModelName = (name: string): string => {
	const modelBase = name.split(":")[0].toLowerCase();

	if (modelBase.includes("llama")) return "meta";
	if (modelBase.includes("mistral")) return "mistralai";
	if (modelBase.includes("phi")) return "microsoft";
	if (modelBase.includes("gemma")) return "google";
	if (modelBase.includes("qwen")) return "alibaba";
	if (modelBase.includes("codellama")) return "meta";

	return "community";
};

// Helper: Format Ollama model name for display
const formatOllamaModelName = (name: string): string => {
	const [modelBase, tag] = name.split(":");

	// Capitalize model name
	let displayName = modelBase
		.split(/[-_]/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");

	// Add tag if not "latest"
	if (tag && tag !== "latest") {
		displayName += ` ${tag.toUpperCase()}`;
	}

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

	// Code Llama has 16k
	if (n.includes("codellama")) return 16000;

	// Gemma has 8k
	if (n.includes("gemma")) return 8192;

	// Default for unknown models
	return 4096;
};

// Helper: Extract context length from Ollama /api/show model_info
const extractContextLength = (modelInfo: Record<string, unknown>): number | undefined => {
	// Look for architecture-specific context_length (e.g., "llama.context_length")
	for (const [key, value] of Object.entries(modelInfo)) {
		if (key.endsWith(".context_length") && typeof value === "number") {
			return value;
		}
	}
	return undefined;
};

/** Thinking effort levels for binary thinking models (on/off toggle). */
const BINARY_THINKING_LEVELS = ["off", "on"];
/** Thinking effort levels for models that support granular levels (e.g. GPT-OSS). */
const LEVEL_THINKING_LEVELS = ["off", "low", "medium", "high"];

/**
 * Determine thinking effort levels for an Ollama model.
 *
 * - Models without `"thinking"` capability → `undefined` (no thinking support)
 * - Models matching `gpt-oss` → level-based thinking ("off"/"low"/"medium"/"high")
 * - All other thinking models → binary thinking ("off"/"on")
 */
export function getOllamaThinkingLevels(
	modelId: string,
	capabilities: string[],
): string[] | undefined {
	if (!capabilities.includes("thinking")) return undefined;

	// GPT-OSS models support granular thinking levels
	if (modelId.toLowerCase().includes("gpt-oss")) {
		return LEVEL_THINKING_LEVELS;
	}

	// Default: binary thinking (QwQ, DeepSeek R1, Qwen 3, etc.)
	return BINARY_THINKING_LEVELS;
}

// Helper: Fetch model capabilities from Ollama /api/show endpoint
const fetchOllamaCapabilities = async (
	modelId: string,
	endpoint: string,
): Promise<{
	supportsTools: boolean;
	supportsImages: boolean;
	supportsCompletion: boolean;
	supportsThinking: boolean;
	capabilities: string[];
	contextLength: number | undefined;
}> => {
	try {
		const showUrl = endpoint.endsWith("/") ? `${endpoint}api/show` : `${endpoint}/api/show`;

		const response = await fetch(showUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: modelId }),
		});

		if (!response.ok) {
			throw new Error(`API returned ${response.status}`);
		}

		const data = (await response.json()) as {
			capabilities?: string[];
			model_info?: Record<string, unknown>;
			parameters?: string;
		};

		const capabilities = data.capabilities || [];

		// Extract context length that Ollama actually uses for inference.
		// Priority: num_ctx from Modelfile parameters (explicit override) >
		// model_info context_length (architectural default).
		let contextLength: number | undefined;

		if (data.parameters) {
			const match = /\bnum_ctx\s+(\d+)/.exec(data.parameters);
			if (match) {
				contextLength = parseInt(match[1], 10);
			}
		}

		if (contextLength === undefined && data.model_info) {
			contextLength = extractContextLength(data.model_info);
		}

		return {
			supportsTools: capabilities.includes("tools"),
			supportsImages: capabilities.includes("vision"),
			supportsCompletion: capabilities.includes("completion"),
			supportsThinking: capabilities.includes("thinking"),
			capabilities,
			contextLength,
		};
	} catch {
		// If /api/show fails, fall back to heuristics
		const n = modelId.toLowerCase();
		return {
			supportsTools:
				n.includes("llama3.1") ||
				n.includes("llama3.2") ||
				n.includes("mistral-nemo") ||
				n.includes("qwen2.5") ||
				n.includes("qwen3"),
			supportsImages: n.includes("llava") || n.includes("vision"),
			supportsCompletion: true, // Most models support completion
			supportsThinking: false,
			capabilities: [],
			contextLength: undefined,
		};
	}
};

// Static fallback models - conservative capabilities
const OLLAMA_FALLBACK: ModelInfo[] = [];

export function registerOllamaProvider(registry: ProviderRegistry, logger: Logger): void {
	// Register model fetcher with dynamic endpoint support
	registry.registerModelFetcher(
		"ollama",
		createCachedModelFetcher<LocalCredentials>({
			providerId: "ollama",
			resolveUrl: (credentials) => {
				return joinPath(credentials.endpoint, "api/tags");
			},
			hasCredentials: (credentials) => Boolean(credentials.endpoint),
			createHeaders: () => ({
				"Content-Type": "application/json",
			}),
			parseResponse: (data: unknown) => {
				const typedData = data as {
					models: Array<{
						name: string;
						size: number;
						details?: {
							family?: string;
							parameter_size?: string;
						};
					}>;
				};

				return typedData.models.map((model) => ({
					id: model.name,
					name: formatOllamaModelName(model.name),
					providerId: "ollama",
					vendor: extractVendorFromModelName(model.name),
					family: model.details?.family,
					maxInputTokens: estimateContextLength(model.name),
					maxOutputTokens: 4096,
					// Capabilities will be enriched via /api/show
					supportsTools: false,
					supportsImages: false,
					supportsToolResultImages: false,
					supportsWebSearch: false,
					maxContextLength: estimateContextLength(model.name),
				}));
			},
			enrichModels: async (models, credentials) => {
				// Enrich each model with capabilities from /api/show
				const endpoint = credentials.endpoint;

				return Promise.all(
					models.map(async (model) => {
						const caps = await fetchOllamaCapabilities(model.id, endpoint);

						return {
							...model,
							supportsTools: caps.supportsTools,
							supportsImages: caps.supportsImages,
							supportedInputMediaTypes: caps.supportsImages
								? ["image/png", "image/jpeg", "image/gif", "image/webp"]
								: undefined,
							// Tool result images not currently supported by Ollama
							supportsToolResultImages: false,
							supportsWebSearch: false,
							// Use actual context length from /api/show if available
							...(caps.contextLength !== undefined && {
								maxInputTokens: caps.contextLength,
								maxContextLength: caps.contextLength,
							}),
							// Thinking support
							thinkingEffortLevels: getOllamaThinkingLevels(model.id, caps.capabilities),
						};
					}),
				);
			},
			fallbackModels: OLLAMA_FALLBACK,
			logger,
			ttl: 5 * 60 * 1000, // 5 minutes - models change when user downloads new ones
		}),
	);

	// Register client factory
	registry.registerClientFactory("ollama", (credentials) => {
		if (credentials.type !== "local") {
			throw new Error(
				`Ollama provider requires local endpoint credentials, got: ${credentials.type}`,
			);
		}
		return new OllamaClient(credentials.endpoint);
	});
}
