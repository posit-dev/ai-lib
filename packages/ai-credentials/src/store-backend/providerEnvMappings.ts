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
	},
};
