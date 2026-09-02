/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025-2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Credential type definitions for authenticating with AI providers.
 *
 * These types form a discriminated union based on the `type` field, covering
 * all credential patterns used across providers: API keys, OAuth tokens,
 * local endpoints, AWS credentials, and Google Cloud credentials.
 *
 * DISK FORMAT WARNING: Consuming packages (core, node) persist data derived
 * from these types to disk (conversations, settings, auth store). While only
 * string values currently flow into persisted formats, interface shape changes
 * here could silently alter on-disk formats if a consuming package starts
 * storing a credential type directly. Before modifying type shapes, consider
 * whether the change could affect serialized data.
 */

// ============================================================================
// Credentials
// ============================================================================

/**
 * API Key credentials (Anthropic, OpenAI, Gemini)
 *
 * customHeaders are user-supplied HTTP headers attached to every model
 * discovery and chat request for this provider. Intended for additive
 * enterprise-gateway headers (e.g. Databricks
 * `x-databricks-use-coding-agent-mode`, tenancy or routing markers).
 *
 * Headers are additive only. SDK/provider-managed header names
 * (`Authorization`, `x-api-key`, `anthropic-version`, `Content-Type`, etc.)
 * are ignored, as are custom headers whose names collide with headers already
 * populated by the provider-specific request path.
 */
export interface ApiKeyCredentials {
	type: "apikey";
	apiKey: string;
	baseUrl?: string;
	customHeaders?: Record<string, string>;
	/**
	 * Snowflake Cortex only. Present iff `apiKey` holds a Snowflake **session
	 * token** (from external-browser SSO) that must be sent as
	 * `Authorization: Snowflake Token="..."` rather than a Bearer token — its
	 * presence is the session-auth discriminant; absence means Bearer. Ignored
	 * by every other provider.
	 *
	 * `sessionConnectionIdentity` is an **opaque, client-bound token** minted by
	 * the credential resolver. It encodes not just the connections.toml connection
	 * name but a snapshot of the connection this token was acquired from (its
	 * endpoint), so the reauthentication hook can refresh *that exact* connection
	 * on expiry (not whatever connection is currently selected) and reject a
	 * refresh whose re-resolved connection no longer matches the bound snapshot —
	 * e.g. the same-named connection was edited in place to a different account.
	 * Consumers treat it as opaque; only the resolver encodes/decodes it. Grouped
	 * so the flag and its required identity are co-present or absent together.
	 *
	 * Synthesized at credential-resolution time and never persisted, so it does
	 * not affect the on-disk credential format.
	 */
	snowflake?: { sessionConnectionIdentity: string };
}

/**
 * OAuth credentials (Posit AI Pass)
 */
export interface OAuthCredentials {
	type: "oauth";
	accessToken: string;
}

/**
 * Local server credentials (Ollama, LM Studio)
 */
export interface LocalCredentials {
	type: "local";
	endpoint: string;
}

/**
 * AWS credentials (Amazon Bedrock)
 */
export interface AwsCredentials {
	type: "aws-credentials";
	region: string;
	profile?: string;
	accessKeyId?: string;
	secretAccessKey?: string;
	sessionToken?: string;
}

/**
 * Google Cloud credentials (Vertex AI).
 *
 * `accessToken` is supplied by credential brokers (e.g. Positron auth ext) so
 * the SDK can authenticate without calling ADC itself. Standalone/node/TUI
 * leave it undefined and let google-auth-library resolve ADC.
 */
export interface GoogleCloudCredentials {
	type: "google-cloud";
	project: string;
	location: string;
	accessToken?: string;
}

/**
 * Microsoft Entra ID credentials (Microsoft Foundry).
 *
 * Carries NO secret material: the Entra token is acquired and refreshed at
 * runtime by `@azure/identity` (DefaultAzureCredential) inside the provider
 * client. `scope` is required because the config resolver assigns the
 * default (`https://cognitiveservices.azure.com/.default`) when the user
 * does not supply one. A fresh entra configuration is synthesized from the
 * provider catalog and never persisted to the credential store.
 */
export interface AzureEntraCredentials {
	type: "azure-entra";
	baseUrl: string;
	scope: string;
	tenantId?: string;
	customHeaders?: Record<string, string>;
}

/**
 * Credentials for authenticating with a provider.
 * Discriminated union based on the 'type' field.
 */
export type ProviderCredentials =
	| ApiKeyCredentials
	| OAuthCredentials
	| LocalCredentials
	| AwsCredentials
	| GoogleCloudCredentials
	| AzureEntraCredentials;
