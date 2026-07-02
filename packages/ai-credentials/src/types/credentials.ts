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
}

/**
 * OAuth credentials (Posit AI)
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
 * Credentials for authenticating with a provider.
 * Discriminated union based on the 'type' field.
 */
export type ProviderCredentials =
	| ApiKeyCredentials
	| OAuthCredentials
	| LocalCredentials
	| AwsCredentials
	| GoogleCloudCredentials;
