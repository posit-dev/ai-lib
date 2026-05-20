/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import {
	BedrockClient as BedrockListClient,
	ListFoundationModelsCommand,
} from "@aws-sdk/client-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

import { getAnthropicModelCapabilities } from "../model-capabilities/anthropic-helpers";
import { BedrockClient } from "../model-clients/BedrockClient";
import type { Logger, ModelInfo, ProviderCredentials } from "../types";
import { NOTIFICATION_ACTIONS } from "../types";
import { isAwsSsoProfileConfigured } from "./bedrock-sso";
import type { ProviderRegistry } from "./ProviderRegistry";

/**
 * Optional callback for platform-specific Bedrock provider status updates
 * Platforms receive full context from the provider to avoid hardcoding constants
 */
export interface BedrockProviderCallbacks {
	/**
	 * Called when provider status changes (success, auth error, network error)
	 *
	 * @param update - Full status update with provider context
	 * @param update.providerId - Provider ID (e.g., "bedrock")
	 * @param update.authMethodId - Auth method ID (e.g., "aws-credentials")
	 * @param update.status - Current status: 'ok', 'auth_error', or 'network_error'
	 * @param update.error - Error details (only present when status is not 'ok')
	 * @param update.error.code - Machine-readable error code (e.g., "sso_expired")
	 * @param update.error.message - User-facing error message
	 * @param update.error.action - Optional action button (label + command ID)
	 */
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

	/**
	 * Called when SSO credentials have expired and automatic login should be attempted.
	 * Implementations should spawn `aws sso login` and wait for completion.
	 *
	 * @param profile - AWS profile name (if configured), used for `--profile` flag
	 * @returns true if SSO login succeeded and credentials should be retried
	 */
	attemptSSOLogin?: (profile?: string) => Promise<boolean>;

	/** Called when credentials have been refreshed and models should be re-fetched */
	requestModelRefresh?: () => void;
}

// Cache TTL for models (1 hour) in milliseconds
const MODEL_CACHE_TTL = 60 * 60 * 1000;

/**
 * Get the cross-region inference profile prefix for an AWS region.
 * Claude 4.x and newer models require inference profiles, not direct model IDs.
 *
 * AWS cross-region inference profiles use these prefixes:
 * - us.* for US regions (us-east-1, us-west-2, etc.)
 * - eu.* for EU regions (eu-west-1, eu-central-1, etc.)
 * - apac.* for Asia-Pacific regions (ap-northeast-1, ap-southeast-1, etc.)
 */
function getInferenceProfilePrefix(region: string): string {
	if (region.startsWith("us-")) {
		return "us";
	}
	if (region.startsWith("eu-")) {
		return "eu";
	}
	if (region.startsWith("ap-")) {
		return "apac";
	}
	// Default to US for unknown regions
	return "us";
}

/**
 * Type guard to check if an error has AWS SDK metadata
 */
function hasAwsMetadata(
	error: unknown,
): error is Error & { $metadata?: { httpStatusCode?: number } } {
	return error instanceof Error && "$metadata" in error;
}

/**
 * Check if an error is an authentication/credential error
 * Uses structured AWS SDK error data instead of string matching
 */
function isAuthError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	// Check AWS SDK error name (most reliable)
	const errorName = error.name;
	if (
		errorName === "ExpiredTokenException" ||
		errorName === "UnrecognizedClientException" ||
		errorName === "InvalidSignatureException" ||
		errorName === "CredentialsProviderError"
	) {
		return true;
	}

	// Check HTTP status code (401 = unauthorized)
	// AWS SDK errors have a $metadata property with httpStatusCode
	if (hasAwsMetadata(error)) {
		const httpStatusCode = error.$metadata?.httpStatusCode;
		if (httpStatusCode === 401 || httpStatusCode === 403) {
			return true;
		}
	}

	// Fallback: specific SSO message (narrow pattern)
	if (error.message.includes("Token is expired") && error.message.includes("aws sso login")) {
		return true;
	}

	return false;
}

/**
 * Narrower check: is this specifically a credential expiry/resolution error
 * where `aws sso login` could help? Excludes 403 (IAM permission denied)
 * which SSO login won't fix.
 */
function isCredentialExpiry(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	// These error names indicate expired/missing/unresolvable credentials
	const errorName = error.name;
	if (
		errorName === "ExpiredTokenException" ||
		errorName === "CredentialsProviderError" ||
		errorName === "InvalidSignatureException"
	) {
		return true;
	}

	// 401 = unauthenticated (credentials expired), distinct from 403 (unauthorized/permissions)
	if (hasAwsMetadata(error)) {
		const httpStatusCode = error.$metadata?.httpStatusCode;
		if (httpStatusCode === 401) {
			return true;
		}
	}

	// Explicit SSO expiry message from AWS SDK
	if (error.message.includes("Token is expired") && error.message.includes("aws sso login")) {
		return true;
	}

	return false;
}

export function registerBedrockProvider(
	registry: ProviderRegistry,
	logger: Logger,
	callbacks?: BedrockProviderCallbacks,
): void {
	// Register model fetcher with closure-based caching (Phase 2)
	registry.registerModelFetcher(
		"bedrock",
		(() => {
			// Closure variables for caching and SSO dedupe
			const TTL = MODEL_CACHE_TTL;
			let lastFetch = 0;
			let cachedModels: ModelInfo[] | null = null;
			let ssoRefreshPending = false;

			const fetcher = async (credentials: ProviderCredentials): Promise<ModelInfo[]> => {
				// 1. Guard: Check credential type
				if (credentials.type !== "aws-credentials") {
					logger.debug("[Bedrock] Wrong credential type, using fallback models");
					return [];
				}

				// 2. Guard: Check region configured
				if (!credentials.region) {
					logger.debug("[Bedrock] No region configured, using fallback models");
					return [];
				}

				// 3. Check cache freshness
				const now = Date.now();
				const cacheAge = cachedModels ? now - lastFetch : null;
				const cacheStatus = cachedModels ? "EXISTS" : "NULL";

				// Verification: Enhanced cache logging
				logger.debug(`[Bedrock] Cache check: status=${cacheStatus}, age=${cacheAge}s, TTL=${TTL}s`);

				if (cachedModels && now - lastFetch < TTL) {
					logger.debug(`[Bedrock] Using cached models (age: ${cacheAge}s, TTL: ${TTL}s)`);
					return cachedModels;
				}

				// 4. Determine auth method (TypeScript knows these fields exist after type check)
				const useManualKeys = credentials.accessKeyId && credentials.secretAccessKey;

				// 5. Try to fetch from Bedrock API (with non-blocking SSO login)
				try {
					logger.debug("[Bedrock] Fetching models from ListFoundationModels API");

					// Create Bedrock list client (NOT runtime client)
					let listClient: BedrockListClient;
					if (useManualKeys) {
						listClient = new BedrockListClient({
							region: credentials.region,
							credentials: {
								accessKeyId: credentials.accessKeyId!,
								secretAccessKey: credentials.secretAccessKey!,
								sessionToken: credentials.sessionToken,
							},
						});
					} else {
						listClient = new BedrockListClient({
							region: credentials.region,
							credentials: fromNodeProviderChain({
								profile: credentials.profile,
							}),
						});
					}

					// List foundation models with cross-region inference profiles. This will find newer
					// Anthropic models, along with models from other vendors.
					//
					// Note: INFERENCE_PROFILE parameter is not yet in @aws-sdk/client-bedrock TypeScript
					// types but is a valid and documented AWS Bedrock feature.
					// @ts-expect-error INFERENCE_PROFILE is valid but not in SDK types yet
					const command = new ListFoundationModelsCommand({
						// byProvider: "Anthropic", // Only Anthropic Claude models
						byInferenceType: "INFERENCE_PROFILE",
						byOutputModality: "TEXT", // Only text output models
					});

					const response = await listClient.send(command);

					// Debug logging
					logger.debug(
						`[Bedrock] API returned ${response.modelSummaries?.length || 0} Anthropic models`,
					);

					// Parse response - construct inference profile IDs
					const regionPrefix = getInferenceProfilePrefix(credentials.region);
					const freshModels: ModelInfo[] =
						response.modelSummaries?.map((model) => {
							// Extract vendor from model ID (e.g., "anthropic.claude-..." → "anthropic")
							const vendor = model.modelId?.split(".")[0] || "aws";

							// Determine capabilities based on model metadata
							const supportsTools = Boolean(
								model.responseStreamingSupported && (vendor === "anthropic" || vendor === "amazon"),
							);
							const supportsImages = vendor === "anthropic" || vendor === "amazon";

							// Construct cross-region inference profile ID
							// Claude 4.x and newer models require inference profiles, not direct model IDs
							// Format: {region-prefix}.{model-id} (e.g., "us.anthropic.claude-sonnet-4-5-...")
							const inferenceProfileId = `${regionPrefix}.${model.modelId}`;

							// Infer capabilities for Anthropic models
							const capabilities = getAnthropicModelCapabilities(model.modelId!);

							return {
								id: inferenceProfileId,
								name: model.modelName || model.modelId!,
								providerId: "bedrock",
								vendor,
								family: undefined,
								maxInputTokens: undefined,
								maxOutputTokens: undefined,
								supportsTools,
								supportsImages,
								supportsToolResultImages: supportsImages,
								supportedInputMediaTypes: supportsImages
									? ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]
									: undefined,
								maxContextLength: 200000,
								// Spread Anthropic capabilities (token limits, family, thinking effort)
								...capabilities,
								supportsWebSearch: false,
							};
						}) || [];

					// Update cache
					lastFetch = Date.now();
					cachedModels = freshModels;
					logger.info(`[Bedrock] Fetched ${freshModels.length} models from API`);

					// Clear any previous auth errors since fetch succeeded
					await callbacks?.onProviderStatusChange?.({
						providerId: "bedrock",
						authMethodId: "aws-credentials",
						status: "ok",
					});

					return freshModels;
				} catch (error) {
					// Check if this is an auth/credential error
					if (isAuthError(error)) {
						const ssoProfileConfigured =
							!useManualKeys && (await isAwsSsoProfileConfigured(credentials.profile));

						// Start non-blocking SSO login for credential expiry errors.
						// The login runs in the background; when it succeeds, requestModelRefresh
						// triggers a full model re-fetch. The ssoRefreshPending flag deduplicates
						// so concurrent fetcher calls don't each attach a handler.
						if (
							!ssoRefreshPending &&
							ssoProfileConfigured &&
							isCredentialExpiry(error) &&
							callbacks?.attemptSSOLogin
						) {
							ssoRefreshPending = true;
							logger.info("[Bedrock] AWS credentials expired, starting background SSO login...");

							callbacks
								.attemptSSOLogin(credentials.profile)
								.then((succeeded) => {
									if (succeeded) {
										logger.info(
											"[Bedrock] Background SSO login succeeded, requesting model refresh",
										);
										callbacks.requestModelRefresh?.();
									} else {
										logger.warn("[Bedrock] Background SSO login failed or was cancelled");
									}
								})
								.catch((err) => {
									logger.error(`[Bedrock] Background SSO login error: ${err}`);
								})
								.finally(() => {
									ssoRefreshPending = false;
								});
						}

						const errorMsg = error instanceof Error ? error.message : String(error);

						if (ssoProfileConfigured && isCredentialExpiry(error)) {
							logger.error(
								`[Bedrock] AWS SSO credentials expired. Run 'aws sso login' to refresh your session. Error: ${errorMsg}`,
							);

							await callbacks?.onProviderStatusChange?.({
								providerId: "bedrock",
								authMethodId: "aws-credentials",
								status: "auth_error",
								error: {
									code: "sso_expired",
									message:
										"AWS Bedrock credentials expired. Please run 'aws sso login' to refresh your session, then click Refresh Models. You may need additional options, like 'aws sso login --profile <profile-name>'.",
									action: {
										label: "Refresh Models",
										commandId: NOTIFICATION_ACTIONS.REFRESH_MODELS,
									},
								},
							});
						} else {
							logger.error(
								`[Bedrock] AWS credentials are invalid, expired, or unavailable. Error: ${errorMsg}`,
							);

							await callbacks?.onProviderStatusChange?.({
								providerId: "bedrock",
								authMethodId: "aws-credentials",
								status: "auth_error",
								error: {
									code: "auth_error",
									message:
										"AWS Bedrock credentials are invalid, expired, or unavailable. Update your AWS credentials, then click Refresh Models.",
									action: {
										label: "Refresh Models",
										commandId: NOTIFICATION_ACTIONS.REFRESH_MODELS,
									},
								},
							});
						}

						// CRITICAL: Clear cache so subsequent requests don't short-circuit
						logger.debug("[Bedrock] Auth error detected, clearing cache");
						cachedModels = null;
						lastFetch = 0;
						logger.debug("[Bedrock] Cache cleared. Next call will fetch fresh.");

						// Return empty array - no fallback for auth errors
						// This signals to UI that provider is unavailable
						return [];
					}

					// For non-auth errors (network, service issues), use fallback gracefully
					const errorMsg = error instanceof Error ? error.message : String(error);
					logger.warn(`[Bedrock] API fetch failed: ${errorMsg}, using fallback`);

					// Notify platform of network error
					await callbacks?.onProviderStatusChange?.({
						providerId: "bedrock",
						authMethodId: "aws-credentials",
						status: "network_error",
						error: {
							code: "network_error",
							message: errorMsg,
						},
					});

					// Return stale cache if available
					if (cachedModels) {
						logger.debug("[Bedrock] Returning stale cached models");
						return cachedModels;
					}

					// Ultimate fallback for transient errors
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
	registry.registerClientFactory("bedrock", (credentials) => {
		if (credentials.type !== "aws-credentials") {
			throw new Error(`Bedrock provider requires AWS credentials, got: ${credentials.type}`);
		}

		return new BedrockClient({
			region: credentials.region,
			profile: credentials.profile,
			accessKeyId: credentials.accessKeyId,
			secretAccessKey: credentials.secretAccessKey,
			sessionToken: credentials.sessionToken,
		});
	});
}
