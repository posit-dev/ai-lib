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
import type { AwsCredentials, Logger, ModelInfo, ProviderCredentials } from "../types";
import { NOTIFICATION_ACTIONS } from "../types";
import { isAwsSsoProfileConfigured } from "./bedrock-sso";
import type { ProviderRegistry } from "./ProviderRegistry";

const BEDROCK_PROVIDER_ID = "bedrock";
const BEDROCK_AUTH_METHOD_ID = "aws-credentials";

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
}

// Cache TTL for models (1 hour) in milliseconds
const MODEL_CACHE_TTL = 60 * 60 * 1000;

/**
 * Get the cross-region inference profile prefix for an AWS region.
 * Claude 4.x and newer models require inference profiles, not direct model IDs.
 *
 * AWS cross-region inference profiles use these prefixes:
 * - us-gov.* for AWS GovCloud regions (us-gov-west-1, us-gov-east-1)
 * - us.* for US regions (us-east-1, us-west-2, etc.)
 * - eu.* for EU regions (eu-west-1, eu-central-1, etc.)
 * - apac.* for Asia-Pacific regions (ap-northeast-1, ap-southeast-1, etc.)
 *
 * GovCloud must be checked before the general `us-` case: `us-gov-west-1`
 * also starts with `us-`, but its profiles live under the `us-gov` partition
 * and the commercial `us.` profiles don't exist there.
 */
export function getInferenceProfilePrefix(region: string): string {
	if (region.startsWith("us-gov-")) {
		return "us-gov";
	}
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

type ManualAwsCredentials = AwsCredentials & {
	accessKeyId: string;
	secretAccessKey: string;
};

function hasManualAwsKeys(credentials: AwsCredentials): credentials is ManualAwsCredentials {
	return Boolean(credentials.accessKeyId && credentials.secretAccessKey);
}

async function notifyBedrockAuthError(
	callbacks: BedrockProviderCallbacks | undefined,
	code: "sso_expired" | "auth_error",
	message: string,
): Promise<void> {
	await callbacks?.onProviderStatusChange?.({
		providerId: BEDROCK_PROVIDER_ID,
		authMethodId: BEDROCK_AUTH_METHOD_ID,
		status: "auth_error",
		error: {
			code,
			message,
			action: {
				label: "Refresh Models",
				commandId: NOTIFICATION_ACTIONS.REFRESH_MODELS,
			},
		},
	});
}

async function reportCredentialResolutionFailure(
	credentials: AwsCredentials,
	callbacks: BedrockProviderCallbacks | undefined,
	logger: Logger,
	credError: unknown,
): Promise<void> {
	const ssoProfileConfigured = await isAwsSsoProfileConfigured(credentials.profile);
	const errorMsg = credError instanceof Error ? credError.message : String(credError);

	if (ssoProfileConfigured) {
		logger.info(
			`[Bedrock] AWS credentials could not be resolved (SSO profile detected). Run 'aws sso login' to authenticate. Error: ${errorMsg}`,
		);
		await notifyBedrockAuthError(
			callbacks,
			"sso_expired",
			"AWS Bedrock credentials expired. Please run 'aws sso login' to refresh your session, then click Refresh Models. You may need additional options, like 'aws sso login --profile <profile-name>'.",
		);
		return;
	}

	logger.error(`[Bedrock] AWS credentials could not be resolved. Error: ${errorMsg}`);
	await notifyBedrockAuthError(
		callbacks,
		"auth_error",
		"AWS Bedrock credentials are invalid or unavailable. Update your AWS credentials, then click Refresh Models.",
	);
}

async function createBedrockListClient(
	credentials: AwsCredentials,
	callbacks: BedrockProviderCallbacks | undefined,
	logger: Logger,
): Promise<BedrockListClient | null> {
	if (hasManualAwsKeys(credentials)) {
		return new BedrockListClient({
			region: credentials.region,
			credentials: {
				accessKeyId: credentials.accessKeyId,
				secretAccessKey: credentials.secretAccessKey,
				sessionToken: credentials.sessionToken,
			},
		});
	}

	const credentialProvider = fromNodeProviderChain({
		profile: credentials.profile,
	});

	try {
		const resolvedCreds = await credentialProvider();
		return new BedrockListClient({
			region: credentials.region,
			credentials: resolvedCreds,
		});
	} catch (credError) {
		await reportCredentialResolutionFailure(credentials, callbacks, logger, credError);
		return null;
	}
}

export function registerBedrockProvider(
	registry: ProviderRegistry,
	logger: Logger,
	callbacks?: BedrockProviderCallbacks,
): void {
	// Register model fetcher with closure-based caching (Phase 2)
	registry.registerModelFetcher(
		BEDROCK_PROVIDER_ID,
		(() => {
			// Closure variables for caching
			const TTL = MODEL_CACHE_TTL;
			let lastFetch = 0;
			let cachedModels: ModelInfo[] | null = null;

			const fetcher = async (credentials: ProviderCredentials): Promise<ModelInfo[]> => {
				// 1. Guard: Check credential type
				if (credentials.type !== BEDROCK_AUTH_METHOD_ID) {
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

				// 4. Resolve credentials, then fetch from Bedrock API.
				// For chain-based credentials (SSO, env, shared config), pre-resolve
				// to detect expired/missing credentials before making the API call.
				// This avoids unnecessary network requests and intrusive SSO login
				// prompts on every startup.
				const listClient = await createBedrockListClient(credentials, callbacks, logger);
				if (!listClient) {
					cachedModels = null;
					lastFetch = 0;
					return [];
				}

				try {
					logger.debug("[Bedrock] Fetching models from ListFoundationModels API");

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
								providerId: BEDROCK_PROVIDER_ID,
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
						providerId: BEDROCK_PROVIDER_ID,
						authMethodId: BEDROCK_AUTH_METHOD_ID,
						status: "ok",
					});

					return freshModels;
				} catch (error) {
					// Credential resolution errors for chain-based auth are handled above.
					// Errors reaching here are from the ListFoundationModels API call itself
					// (e.g. IAM permission denied, expired temporary credentials, network issues).
					if (isAuthError(error)) {
						const errorMsg = error instanceof Error ? error.message : String(error);
						logger.error(`[Bedrock] AWS Bedrock API rejected credentials. Error: ${errorMsg}`);

						await notifyBedrockAuthError(
							callbacks,
							"auth_error",
							"AWS Bedrock credentials were rejected by the API. Check your IAM permissions, then click Refresh Models.",
						);

						cachedModels = null;
						lastFetch = 0;
						return [];
					}

					// For non-auth errors (network, service issues), use fallback gracefully
					const errorMsg = error instanceof Error ? error.message : String(error);
					logger.warn(`[Bedrock] API fetch failed: ${errorMsg}, using fallback`);

					await callbacks?.onProviderStatusChange?.({
						providerId: BEDROCK_PROVIDER_ID,
						authMethodId: BEDROCK_AUTH_METHOD_ID,
						status: "network_error",
						error: {
							code: "network_error",
							message: errorMsg,
						},
					});

					if (cachedModels) {
						logger.debug("[Bedrock] Returning stale cached models");
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
	registry.registerClientFactory(BEDROCK_PROVIDER_ID, (credentials) => {
		if (credentials.type !== BEDROCK_AUTH_METHOD_ID) {
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
