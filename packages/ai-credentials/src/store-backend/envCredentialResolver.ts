/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Environment Variable Credential Resolver
 *
 * Resolves provider credentials from environment variables. This provides a
 * first-class env-credential path so that env API keys (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, etc.) resolve without depending on legacy fallbacks.
 *
 * This resolver maps `PROVIDER_ENV_MAPPINGS` secret env vars → ProviderCredentials.
 * Non-secret env vars (like *_BASE_URL) are handled by ai-config/providers.json and
 * are not part of this resolver.
 *
 * Moved from @assistant/node so that ai-credentials/store-backend can resolve
 * credentials without importing @assistant/*.
 */

import type { ProviderCredentials } from "../types/credentials.js";
import { PROVIDER_ENV_MAPPINGS, type ProviderEnvMapping } from "./providerEnvMappings.js";

/**
 * Attempt to resolve credentials for a provider from environment variables.
 *
 * Returns `null` if the relevant env vars are not set. Only resolves
 * **secret** credential fields (API keys, AWS secret keys). Non-secret
 * connection config (baseUrl, region, endpoint) is handled by ai-config
 * and merged via catalog connection.
 *
 * @param providerId - The provider to resolve credentials for
 * @param envVars - Environment variables to read from (defaults to process.env)
 */
export function resolveCredentialsFromEnv(
	providerId: string,
	envVars: Record<string, string | undefined> = process.env,
): ProviderCredentials | null {
	const mapping = PROVIDER_ENV_MAPPINGS[providerId];
	if (!mapping) return null;

	return resolveFromMapping(mapping, envVars);
}

/**
 * Check whether any secret env vars are set for a provider.
 * Useful for auth status reporting.
 */
export function hasEnvCredentials(
	providerId: string,
	envVars: Record<string, string | undefined> = process.env,
): boolean {
	return resolveCredentialsFromEnv(providerId, envVars) !== null;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function resolveFromMapping(
	mapping: ProviderEnvMapping,
	envVars: Record<string, string | undefined>,
): ProviderCredentials | null {
	// API key providers
	if (mapping.apiKey) {
		const apiKey = envVars[mapping.apiKey];
		if (apiKey) {
			return {
				type: "apikey",
				apiKey,
			};
		}
		return null;
	}

	// AWS credentials
	if (mapping.aws) {
		const accessKeyId = mapping.aws.accessKeyId ? envVars[mapping.aws.accessKeyId] : undefined;
		const secretAccessKey = mapping.aws.secretAccessKey
			? envVars[mapping.aws.secretAccessKey]
			: undefined;

		// Only resolve if actual secret credentials are present.
		// Region/profile alone are non-secret config handled by ai-config.
		if (accessKeyId || secretAccessKey) {
			const region = mapping.aws.region ? envVars[mapping.aws.region] : undefined;
			const profile = mapping.aws.profile ? envVars[mapping.aws.profile] : undefined;
			const sessionToken = mapping.aws.sessionToken ? envVars[mapping.aws.sessionToken] : undefined;

			return {
				type: "aws-credentials",
				region: region ?? "us-east-1",
				profile,
				accessKeyId,
				secretAccessKey,
				sessionToken,
			};
		}
		return null;
	}

	// OAuth providers (positai) — env vars don't carry secrets for OAuth;
	// tokens come from the auth flow only.
	// Local providers (ollama, lmstudio) — endpoints are non-secret, handled by ai-config.
	// Google Cloud — uses ADC, no env-secret resolution needed.
	return null;
}
