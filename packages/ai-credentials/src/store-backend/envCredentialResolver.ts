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
import {
	type EnvironmentFieldDescriptor,
	PROVIDER_ENV_MAPPINGS,
	type ProviderEnvMapping,
	readSdkCredentialEnvironment,
} from "./providerEnvMappings.js";

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
	envVars: Readonly<Record<string, string | undefined>> = process.env,
): ProviderCredentials | null {
	if (providerId === "databricks" && isWorkbenchManagedDatabricks(envVars)) return null;

	const mapping = PROVIDER_ENV_MAPPINGS[providerId];
	if (!mapping) return null;

	return resolveFromMapping(mapping, envVars);
}

/**
 * Whether Posit Workbench provisioned the Databricks profile. The admin
 * credential then outranks every Databricks credential in the shell (PAT and
 * M2M alike), so environment resolution yields nothing.
 */
export function isWorkbenchManagedDatabricks(
	envVars: Readonly<Record<string, string | undefined>>,
): boolean {
	return (readSdkCredentialEnvironment(envVars).databricksConfigFile ?? "").includes(
		"posit-workbench",
	);
}

/**
 * Check whether any secret env vars are set for a provider.
 * Useful for auth status reporting.
 */
export function hasEnvCredentials(
	providerId: string,
	envVars: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	return resolveCredentialsFromEnv(providerId, envVars) !== null;
}

/**
 * The environment variables that can carry a provider's credential, in the
 * order they are read: its API key and older names, AWS keys, or Databricks
 * OAuth M2M fields. Names only; for diagnostics that report presence.
 */
export function credentialEnvironmentNames(providerId: string): readonly string[] {
	const mapping = PROVIDER_ENV_MAPPINGS[providerId];
	if (!mapping) return [];
	const descriptors = [
		...apiKeyDescriptors(mapping),
		...(mapping.aws
			? [mapping.aws.accessKeyId, mapping.aws.secretAccessKey, mapping.aws.sessionToken]
			: []),
		...(mapping.oauthM2m ? Object.values(mapping.oauthM2m) : []),
	];
	return descriptors.flatMap((descriptor) => (descriptor ? [descriptor.name] : []));
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function apiKeyDescriptors(mapping: ProviderEnvMapping): readonly EnvironmentFieldDescriptor[] {
	return mapping.apiKey ? [mapping.apiKey, ...(mapping.apiKeyAliases ?? [])] : [];
}

function resolveFromMapping(
	mapping: ProviderEnvMapping,
	envVars: Readonly<Record<string, string | undefined>>,
): ProviderCredentials | null {
	// API key providers
	if (mapping.apiKey) {
		for (const descriptor of apiKeyDescriptors(mapping)) {
			const apiKey = envVars[descriptor.name];
			if (apiKey) {
				return { type: "apikey", apiKey };
			}
		}
		return null;
	}

	// AWS credentials
	if (mapping.aws) {
		const accessKeyId = mapping.aws.accessKeyId ? envVars[mapping.aws.accessKeyId.name] : undefined;
		const secretAccessKey = mapping.aws.secretAccessKey
			? envVars[mapping.aws.secretAccessKey.name]
			: undefined;

		// Only resolve if actual secret credentials are present.
		// Region/profile alone are non-secret config handled by ai-config.
		if (accessKeyId || secretAccessKey) {
			const region = mapping.aws.region ? envVars[mapping.aws.region.name] : undefined;
			const profile = mapping.aws.profile ? envVars[mapping.aws.profile.name] : undefined;
			const sessionToken = mapping.aws.sessionToken
				? envVars[mapping.aws.sessionToken.name]
				: undefined;

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
