/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025-2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider Environment Variable Mappings (Internal Build Variant)
 *
 * Maps environment variable names to **secret** provider credential fields.
 * Used by envCredentialResolver to resolve API keys and AWS secrets from
 * environment variables.
 *
 * Non-secret connection config (baseUrl, endpoint, oauth, googleCloud) is now
 * handled by ai-config's CONNECTION_ENV_MAPPINGS in the catalog builder.
 *
 * Moved from @assistant/node so that ai-credentials/store-backend can resolve
 * credentials without importing @assistant/*.
 *
 * SYNC NOTE: The ProviderEnvMapping interface is imported by
 * providerEnvMappings-external.ts. If you modify the interface here,
 * the external variant picks it up automatically.
 */

export interface ProviderEnvMapping {
	apiKey?: string;
	oauthM2m?: {
		authType: string;
		host: string;
		clientId: string;
		clientSecret: string;
	};
	aws?: {
		region?: string;
		profile?: string;
		accessKeyId?: string;
		secretAccessKey?: string;
		sessionToken?: string;
	};
}

/**
 * Registry of secret environment variable names for each provider.
 *
 * Only secret credential fields go here. Non-secret connection config
 * (baseUrl, endpoint, oauth settings, googleCloud settings) is handled
 * by ai-config's env overlay in the catalog builder.
 *
 * AWS region/profile appear here so the env credential resolver can
 * construct valid aws-credentials objects when env secrets are present.
 * They also appear in ai-config's CONNECTION_ENV_MAPPINGS for catalog
 * connection resolution — this is intentional, not a duplication error.
 */
export const PROVIDER_ENV_MAPPINGS: Record<string, ProviderEnvMapping> = {
	anthropic: {
		apiKey: "ANTHROPIC_API_KEY",
	},
	openai: {
		apiKey: "OPENAI_API_KEY",
	},
	gemini: {
		apiKey: "GEMINI_API_KEY",
	},
	openrouter: {
		apiKey: "OPENROUTER_API_KEY",
	},
	bedrock: {
		aws: {
			region: "AWS_REGION",
			profile: "AWS_PROFILE",
			accessKeyId: "AWS_ACCESS_KEY_ID",
			secretAccessKey: "AWS_SECRET_ACCESS_KEY",
			sessionToken: "AWS_SESSION_TOKEN",
		},
	},
	"openai-compatible": {
		apiKey: "OPENAI_COMPATIBLE_API_KEY",
	},
	"ms-foundry": {
		apiKey: "MS_FOUNDRY_API_KEY",
	},
	"snowflake-cortex": {
		apiKey: "SNOWFLAKE_TOKEN",
	},
	deepseek: {
		apiKey: "DEEPSEEK_API_KEY",
	},
	databricks: {
		apiKey: "DATABRICKS_TOKEN",
		oauthM2m: {
			authType: "DATABRICKS_AUTH_TYPE",
			host: "DATABRICKS_HOST",
			clientId: "DATABRICKS_CLIENT_ID",
			clientSecret: "DATABRICKS_CLIENT_SECRET",
		},
	},
	litellm: {
		apiKey: "LITELLM_API_KEY",
	},
	portkey: {
		apiKey: "PORTKEY_API_KEY",
	},
	// The standard Posit Connect API-key variable (rsconnect/connectapi
	// convention); pairs with ai-config's POSIT_CONNECT_URL connection var.
	"posit-connect": {
		apiKey: "CONNECT_API_KEY",
	},
};

export interface CapturedProviderEnvironment {
	/** Environment names declared by the selected providers, sorted and deduplicated. */
	readonly declaredNames: readonly string[];
	/** Immutable snapshot containing only the selected providers' declared names. */
	readonly environment: Readonly<Record<string, string | undefined>>;
}

/**
 * Capture the credential environment required by a resolved provider catalog.
 *
 * Credential lookup is lazy, so a host that intends to scrub its ambient
 * environment cannot discover the required names by observing reads. This
 * helper derives them statically from the provider mapping and captures only
 * those entries before the host mutates its environment. The host remains the
 * owner of any wider scrub policy and of the deletion itself.
 */
export function captureProviderEnvironment(
	providerIds: readonly string[],
	env: Readonly<Record<string, string | undefined>>,
): CapturedProviderEnvironment {
	const declaredNames = [...new Set(providerIds.flatMap(providerEnvironmentNames))].sort();
	const environment: Record<string, string | undefined> = {};
	for (const name of declaredNames) {
		environment[name] = env[name];
	}
	return {
		declaredNames: Object.freeze(declaredNames),
		environment: Object.freeze(environment),
	};
}

function providerEnvironmentNames(providerId: string): string[] {
	const mapping = PROVIDER_ENV_MAPPINGS[providerId];
	if (!mapping) return [];
	return [
		...(mapping.apiKey ? [mapping.apiKey] : []),
		...(mapping.oauthM2m ? Object.values(mapping.oauthM2m) : []),
		...(mapping.aws
			? Object.values(mapping.aws).filter((name): name is string => name !== undefined)
			: []),
	];
}
