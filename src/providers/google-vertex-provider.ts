/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { GoogleAuth } from "google-auth-library";

import { getAnthropicModelCapabilities } from "../model-capabilities/anthropic-helpers";
import { GoogleVertexClient } from "../model-clients/GoogleVertexClient";
import type { Logger, ModelInfo, ProviderCredentials } from "../types";
import { NOTIFICATION_ACTIONS } from "../types";
import type { ProviderRegistry } from "./ProviderRegistry";

/**
 * Optional callbacks for platform-specific Google Vertex provider status updates.
 * Same interface shape as BedrockProviderCallbacks.
 */
export interface GoogleVertexProviderCallbacks {
	onProviderStatusChange?: (update: {
		providerId: string;
		authMethodId: string;
		status: "ok" | "auth_error" | "network_error";
		error?: {
			code: string;
			message: string;
			action?: {
				label: string;
				commandId: string;
			};
		};
	}) => Promise<void>;
}

/**
 * Check whether an error from google-auth-library or the Vertex API indicates
 * expired / missing ADC credentials (similar to Bedrock's `isAuthError`).
 */
function isAuthError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const msg = error.message;
	// google-auth-library: refresh token revoked or expired
	if (msg.includes("invalid_grant") || msg.includes("Token has been expired or revoked"))
		return true;
	// google-auth-library: no ADC file found
	if (msg.includes("Could not load the default credentials")) return true;
	// Vertex API 401/403
	if (
		msg.includes("Request had invalid authentication credentials") ||
		msg.includes("UNAUTHENTICATED")
	) {
		return true;
	}
	return false;
}

// Cache TTL for models (1 hour) in milliseconds
const MODEL_CACHE_TTL = 60 * 60 * 1000;

/**
 * Resolve an access token for the Vertex AI REST API.
 * Uses a broker-provided token (e.g. from Positron auth ext) when available;
 * otherwise falls back to Application Default Credentials.
 */
async function getAccessToken(brokered?: string): Promise<string> {
	if (brokered) return brokered;
	const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
	const client = await auth.getClient();
	const { token } = await client.getAccessToken();
	if (!token) {
		throw new Error("Failed to obtain access token from Application Default Credentials");
	}
	return token;
}

/**
 * Fetch models from a single Vertex AI publisher endpoint.
 */
async function fetchPublisherModels(
	project: string,
	location: string,
	publisher: string,
	token: string,
): Promise<
	Array<{ name: string; displayName?: string; inputTokenLimit?: number; outputTokenLimit?: number }>
> {
	// v1beta1 is required — the publisher model listing endpoint is not available in v1
	// https://docs.cloud.google.com/vertex-ai/docs/reference/rest/v1beta1/publishers.models/list
	const host =
		location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
	const url = `https://${host}/v1beta1/publishers/${publisher}/models`;
	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${token}`,
			"x-goog-user-project": project,
		},
		signal: AbortSignal.timeout(15000),
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Vertex AI API returned ${response.status}: ${response.statusText} - ${body}`);
	}

	const data = (await response.json()) as {
		publisherModels?: Array<{
			name: string;
			displayName?: string;
			inputTokenLimit?: number;
			outputTokenLimit?: number;
		}>;
	};
	return data.publisherModels || [];
}

/**
 * Strip resource name prefix from model name.
 * e.g. "publishers/google/models/gemini-2.5-pro" -> "gemini-2.5-pro"
 */
export function stripResourcePrefix(name: string): string {
	const match = name.match(/publishers\/[^/]+\/models\/(.+)/);
	return match ? match[1] : name;
}

/**
 * Generate a human-readable display name from a Gemini model ID.
 * e.g. "gemini-2.5-pro" -> "Gemini 2.5 Pro"
 *      "gemini-3.1-pro-preview" -> "Gemini 3.1 Pro (Preview)"
 *      "gemini-2.0-flash-001" -> "Gemini 2.0 Flash"
 */
export function geminiDisplayName(modelId: string): string {
	// Strip version suffixes like -001, -09-2025
	let id = modelId.replace(/-\d{3}$/, "").replace(/-\d{2}-\d{4}$/, "");

	// Extract and remove preview suffix (with optional date like -preview-0514)
	const isPreview = id.includes("-preview");
	id = id.replace(/-preview(-\d+)?$/, "");

	// Parse: gemini-{version}-{variant}
	const match = id.match(/^gemini-(\d+(?:\.\d+)?)-(.+)$/);
	if (!match) return modelId;

	const version = match[1];
	const variant = match[2]
		.split("-")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");

	return `Gemini ${version} ${variant}${isPreview ? " (Preview)" : ""}`;
}

/**
 * Generate a human-readable display name from a Claude model ID.
 *
 * Handles both Claude 4+ format (claude-{tier}-{major}-{minor}) and
 * Claude 3.x format (claude-{major}-{minor}-{tier}):
 *   "claude-opus-4-6"             -> "Claude Opus 4.6"
 *   "claude-sonnet-4"             -> "Claude Sonnet 4"
 *   "claude-haiku-4-5-20251001"   -> "Claude Haiku 4.5"
 *   "claude-3-5-sonnet-20241022"  -> "Claude 3.5 Sonnet"
 *   "claude-3-opus-20240229"      -> "Claude 3 Opus"
 */
export function claudeDisplayName(modelId: string): string {
	// Strip date suffixes (e.g. -20241022, -20250929)
	const id = modelId.replace(/-\d{8}$/, "");

	// Claude 3.x format: claude-{major}-{minor?}-{tier}
	const oldMatch = id.match(/^claude-(\d+)(?:-(\d+))?-(\w+)/);
	if (oldMatch) {
		const version = oldMatch[2] ? `${oldMatch[1]}.${oldMatch[2]}` : oldMatch[1];
		const tier = oldMatch[3].charAt(0).toUpperCase() + oldMatch[3].slice(1);
		return `Claude ${version} ${tier}`;
	}

	// Claude 4+ format: claude-{tier}-{major}-{minor?}
	const newMatch = id.match(/^claude-(\w+)-(\d+)(?:-(\d+))?/);
	if (!newMatch) return modelId;
	const tier = newMatch[1].charAt(0).toUpperCase() + newMatch[1].slice(1);
	const version = newMatch[3] ? `${newMatch[2]}.${newMatch[3]}` : newMatch[2];
	return `Claude ${tier} ${version}`;
}

export function registerGoogleVertexProvider(
	registry: ProviderRegistry,
	logger: Logger,
	callbacks?: GoogleVertexProviderCallbacks,
): void {
	// Register model fetcher with closure-based caching
	registry.registerModelFetcher(
		"google-vertex",
		(() => {
			const TTL = MODEL_CACHE_TTL;
			let lastFetch = 0;
			let cachedModels: ModelInfo[] | null = null;

			const fetcher = async (credentials: ProviderCredentials): Promise<ModelInfo[]> => {
				// 1. Guard: Check credential type
				if (credentials.type !== "google-cloud") {
					logger.warn(`[GoogleVertex] Wrong credential type '${credentials.type}'`);
					return [];
				}

				// 2. Guard: Check project configured
				if (!credentials.project) {
					logger.warn("[GoogleVertex] No project configured");
					return [];
				}

				// 3. Check cache freshness
				const now = Date.now();
				if (cachedModels && now - lastFetch < TTL) {
					logger.debug("[GoogleVertex] Using cached models");
					return cachedModels;
				}

				// 4. Try to fetch from Vertex AI API
				try {
					const location = credentials.location || "us-central1";

					logger.info(
						`[GoogleVertex] Fetching models from Vertex AI API (project=${credentials.project}, location=${location}, anthropicLocation=global)`,
					);

					const token = await getAccessToken(credentials.accessToken);

					// Fetch from both publishers in parallel, collecting errors
					// so that if both fail we can propagate to the outer catch
					let googleError: Error | null = null;
					let anthropicError: Error | null = null;
					const [googleModels, anthropicModels] = await Promise.all([
						fetchPublisherModels(credentials.project, location, "google", token).catch((err) => {
							googleError = err instanceof Error ? err : new Error(String(err));
							logger.warn(`[GoogleVertex] Failed to fetch Google models: ${googleError.message}`);
							return [];
						}),
						fetchPublisherModels(credentials.project, "global", "anthropic", token).catch((err) => {
							anthropicError = err instanceof Error ? err : new Error(String(err));
							logger.warn(
								`[GoogleVertex] Failed to fetch Anthropic models: ${anthropicError.message}`,
							);
							return [];
						}),
					]);

					// If both publisher fetches failed, re-throw so the outer catch
					// can surface auth_error / network_error status to the UI
					if (googleError && anthropicError) {
						throw isAuthError(googleError)
							? googleError
							: isAuthError(anthropicError)
								? anthropicError
								: googleError;
					}

					const freshModels: ModelInfo[] = [];

					// Parse Google models - only include Gemini text generation models
					// Exclude embedding, image generation, computer-use, and other non-chat models
					for (const model of googleModels) {
						const id = stripResourcePrefix(model.name);
						if (!id.includes("gemini")) continue;
						if (/embedding|image|computer-use/.test(id)) continue;

						freshModels.push({
							id,
							name: geminiDisplayName(id),
							providerId: "google-vertex",
							vendor: "google",
							family: undefined,
							maxInputTokens: model.inputTokenLimit || 1000000,
							maxOutputTokens: model.outputTokenLimit || 65536,
							supportsTools: true,
							supportsImages: true,
							supportsToolResultImages: false,
							supportedInputMediaTypes: [
								"image/png",
								"image/jpeg",
								"image/gif",
								"image/webp",
								"application/pdf",
							],
							supportsWebSearch: false,
							maxContextLength: model.inputTokenLimit || 1000000,
						});
					}

					// Parse Anthropic partner models
					for (const model of anthropicModels) {
						const id = stripResourcePrefix(model.name);
						const capabilities = getAnthropicModelCapabilities(id);

						freshModels.push({
							id,
							name: claudeDisplayName(id),
							providerId: "google-vertex",
							vendor: "anthropic",
							family: undefined,
							maxInputTokens: undefined,
							maxOutputTokens: undefined,
							supportsTools: true,
							supportsImages: true,
							supportsToolResultImages: true,
							supportedInputMediaTypes: [
								"image/png",
								"image/jpeg",
								"image/gif",
								"image/webp",
								"application/pdf",
							],
							maxContextLength: 200000,
							// Spread Anthropic capabilities (token limits, family, thinking effort)
							...capabilities,
							supportsWebSearch: false,
						});
					}

					if (freshModels.length === 0) {
						logger.warn("[GoogleVertex] API returned no models");
						return cachedModels || [];
					}

					// Update cache
					lastFetch = now;
					cachedModels = freshModels;
					logger.info(`[GoogleVertex] Fetched ${freshModels.length} models from API`);

					// Clear any previous auth errors since fetch succeeded
					await callbacks?.onProviderStatusChange?.({
						providerId: "google-vertex",
						authMethodId: "google-cloud",
						status: "ok",
					});

					return freshModels;
				} catch (error) {
					const errorMsg = error instanceof Error ? error.message : String(error);

					if (isAuthError(error)) {
						const isBrokeredAuth = Boolean(credentials.accessToken);
						const authMessage = isBrokeredAuth
							? "Google Cloud authentication expired or is unavailable. Reconnect Google Cloud auth in Positron, then click Refresh Models."
							: "Google Cloud credentials expired or missing. Run 'gcloud auth application-default login' to refresh, then click Refresh Models.";
						logger.error(`[GoogleVertex] ${authMessage} Error: ${errorMsg}`);

						await callbacks?.onProviderStatusChange?.({
							providerId: "google-vertex",
							authMethodId: "google-cloud",
							status: "auth_error",
							error: {
								code: isBrokeredAuth ? "google_cloud_auth_expired" : "adc_expired",
								message: authMessage,
								action: {
									label: "Refresh Models",
									commandId: NOTIFICATION_ACTIONS.REFRESH_MODELS,
								},
							},
						});

						// Clear cache so subsequent requests don't short-circuit
						cachedModels = null;
						lastFetch = 0;

						return [];
					}

					// Non-auth errors (network, service issues)
					logger.warn(`[GoogleVertex] API fetch failed: ${errorMsg}, using fallback`);

					await callbacks?.onProviderStatusChange?.({
						providerId: "google-vertex",
						authMethodId: "google-cloud",
						status: "network_error",
						error: {
							code: "network_error",
							message: errorMsg,
						},
					});

					// Return stale cache if available, otherwise static fallback
					if (cachedModels) {
						logger.debug("[GoogleVertex] Returning stale cached models");
						return cachedModels;
					}

					return [];
				}
			};

			fetcher.clearCache = () => {
				cachedModels = null;
				lastFetch = 0;
			};

			return fetcher;
		})(),
	);

	// Register client factory
	registry.registerClientFactory("google-vertex", (credentials) => {
		if (credentials.type !== "google-cloud") {
			throw new Error(
				"Google Vertex provider requires Google Cloud credentials, got: " + credentials.type,
			);
		}

		return new GoogleVertexClient({
			project: credentials.project,
			location: credentials.location,
			accessToken: credentials.accessToken,
		});
	});
}
