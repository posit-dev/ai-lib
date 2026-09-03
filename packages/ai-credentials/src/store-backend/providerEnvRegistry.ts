/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025-2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider Environment Variable Registry (Internal Build Variant)
 *
 * Data only: the full registry of environment variable descriptors for each
 * provider. All behavior (env resolution, capture partitions, the typed SDK
 * reader) lives in `providerEnvMappings.ts` and is shared by both builds —
 * external builds alias THIS module to `providerEnvRegistry-external.ts`
 * (an empty registry) via bundler file-level aliasing, so the external
 * variant can never drift from the shared implementation.
 */

import type { EnvironmentFieldDescriptor, ProviderEnvMapping } from "./providerEnvMappings.js";

/** Shorthand for a captured-and-scrubbed field (the common case). */
function scrubbed(name: string): EnvironmentFieldDescriptor {
	return { name, scrub: true };
}

/** Shorthand for a capture-only field; the value remains ambient. */
function ambient(name: string): EnvironmentFieldDescriptor {
	return { name, scrub: false };
}

/**
 * Registry of environment variable names for each provider.
 *
 * Only credential fields go here. Non-secret connection config (baseUrl,
 * endpoint, oauth settings, googleCloud settings) is handled by ai-config's
 * env overlay in the catalog builder.
 *
 * AWS region/profile appear here so the env credential resolver can
 * construct valid aws-credentials objects when env secrets are present.
 * They also appear in ai-config's CONNECTION_ENV_MAPPINGS for catalog
 * connection resolution — this is intentional, not a duplication error.
 *
 * All fields are `scrub: true` today, preserving the historical behavior of
 * deleting every declared name from the ambient environment — including
 * non-secret support values (AWS_REGION, DATABRICKS_HOST, …). The only
 * capture-only fields are the Azure tenant/client IDs, which are non-secret
 * inputs to SDK credential construction that user code may also read.
 */
export const PROVIDER_ENV_MAPPINGS: Record<string, ProviderEnvMapping> = {
	anthropic: {
		apiKey: scrubbed("ANTHROPIC_API_KEY"),
	},
	openai: {
		apiKey: scrubbed("OPENAI_API_KEY"),
	},
	gemini: {
		apiKey: scrubbed("GEMINI_API_KEY"),
	},
	openrouter: {
		apiKey: scrubbed("OPENROUTER_API_KEY"),
	},
	bedrock: {
		aws: {
			region: scrubbed("AWS_REGION"),
			profile: scrubbed("AWS_PROFILE"),
			accessKeyId: scrubbed("AWS_ACCESS_KEY_ID"),
			secretAccessKey: scrubbed("AWS_SECRET_ACCESS_KEY"),
			sessionToken: scrubbed("AWS_SESSION_TOKEN"),
		},
	},
	"openai-compatible": {
		apiKey: scrubbed("OPENAI_COMPATIBLE_API_KEY"),
	},
	"ms-foundry": {
		apiKey: scrubbed("MS_FOUNDRY_API_KEY"),
		sdkCredentialEnvironment: {
			azureClientSecret: scrubbed("AZURE_CLIENT_SECRET"),
			azureClientCertificatePath: scrubbed("AZURE_CLIENT_CERTIFICATE_PATH"),
			azureClientCertificatePassword: scrubbed("AZURE_CLIENT_CERTIFICATE_PASSWORD"),
			azureTenantId: ambient("AZURE_TENANT_ID"),
			azureClientId: ambient("AZURE_CLIENT_ID"),
		},
	},
	"snowflake-cortex": {
		apiKey: scrubbed("SNOWFLAKE_TOKEN"),
	},
	deepseek: {
		apiKey: scrubbed("DEEPSEEK_API_KEY"),
	},
	databricks: {
		apiKey: scrubbed("DATABRICKS_TOKEN"),
		oauthM2m: {
			authType: scrubbed("DATABRICKS_AUTH_TYPE"),
			host: scrubbed("DATABRICKS_HOST"),
			clientId: scrubbed("DATABRICKS_CLIENT_ID"),
			clientSecret: scrubbed("DATABRICKS_CLIENT_SECRET"),
		},
	},
	litellm: {
		apiKey: scrubbed("LITELLM_API_KEY"),
	},
	portkey: {
		apiKey: scrubbed("PORTKEY_API_KEY"),
	},
	// The standard Posit Connect API-key variable (rsconnect/connectapi
	// convention); pairs with ai-config's POSIT_CONNECT_URL connection var.
	"posit-connect": {
		apiKey: scrubbed("CONNECT_API_KEY"),
	},
	// Google Application Default Credentials file, read directly by the
	// google-auth-library SDK on the lazy Vertex credential path.
	"google-vertex": {
		sdkCredentialEnvironment: {
			googleApplicationCredentials: scrubbed("GOOGLE_APPLICATION_CREDENTIALS"),
		},
	},
};
