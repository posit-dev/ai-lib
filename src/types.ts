/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025-2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider-Bridge Types
 *
 * Provider-domain type definitions owned by ai-provider-bridge.
 *
 * DISK FORMAT WARNING: Consuming packages (core, node) persist data derived
 * from these types to disk (conversations, settings, auth store). While only
 * string values (ProviderId, model IDs) currently flow into persisted formats,
 * interface shape changes here could silently alter on-disk formats if a
 * consuming package starts storing a provider-bridge type directly. Before
 * modifying type shapes, consider whether the change could affect serialized
 * data. See StoredProviderCredentials in NodeAuthService.ts for the correct
 * pattern: define the disk format independently, convert at the boundary.
 */

import type * as ai from "ai";

// ============================================================================
// Provider IDs
// ============================================================================

/**
 * Provider IDs - Single source of truth for all provider identifiers.
 * Used for type-safe configuration and filtering.
 */
export const PROVIDER_IDS = [
	"positai",
	"anthropic",
	"copilot",
	"openai",
	"bedrock",
	"gemini",
	"openrouter",
	"google-vertex",
	"ollama",
	"lmstudio",
	"openai-compatible",
	"snowflake-cortex",
	"ms-foundry",
	"deepseek",
] as const;

/**
 * Type for provider IDs - derived from PROVIDER_IDS tuple for type safety.
 */
export type ProviderId = (typeof PROVIDER_IDS)[number];

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

// ============================================================================
// Model Info
// ============================================================================

/**
 * Information about a language model
 */
export interface ModelInfo {
	/**
	 * Provider-specific model ID
	 * This is the EXACT string sent to the provider's API
	 *
	 * Examples:
	 *   - Anthropic: "claude-sonnet-4.5-20250929"
	 *   - OpenRouter: "anthropic/claude-sonnet-4.5"
	 *   - Ollama: "llama3:70b"
	 *
	 * Used for: API calls, preferences, everything
	 */
	id: string;

	/** Model name for display (without provider prefix) */
	name: string;

	/** Which provider offers this model */
	providerId: ProviderId;

	/** Who created the model (may differ from provider) */
	vendor: string;

	/**
	 * Optional model-line metadata, used to group exact IDs into a stable family.
	 *
	 * Examples:
	 *   - vendor: "openai", family: "gpt-5.4"
	 *   - vendor: "anthropic", family: "claude-4.6"
	 *   - vendor: "google", family: "gemini-2.5"
	 *
	 * Unlike `vendor`, which identifies who made the model, `family` identifies
	 * which model line/version bucket it belongs to. This may come from upstream
	 * model metadata when available or be inferred locally from the model ID.
	 */
	family?: string;

	maxInputTokens?: number;
	maxOutputTokens?: number;

	/**
	 * API protocol used to communicate with this model, for this specific provider.
	 * For providers that support multiple protocols, like Posit AI or Bedrock.
	 * - "anthropic": Anthropic Messages API format
	 * - "openai": OpenAI Chat Completions API format
	 * If not specified, provider determines the protocol
	 */
	protocol?: "anthropic" | "openai";

	// Capability fields (all optional for backward compatibility)
	supportsTools: boolean;
	supportsImages: boolean; // Images in user messages
	supportsToolResultImages: boolean; // Images in tool call results
	/**
	 * MIME types this model accepts as native content parts (ImagePart, FilePart).
	 * `undefined` means no native file support. Text-file injection is always available.
	 */
	supportedInputMediaTypes?: string[];
	/** Whether Posit Assistant may expose and invoke provider-native web search
	 * for this model. */
	supportsWebSearch: boolean;
	thinkingEffortLevels?: string[];
	/** Whether the model requires vLLM-style `chat_template_kwargs` to enable thinking. */
	requiresChatTemplateKwargs?: boolean;
	maxContextLength: number;
}

// ============================================================================
// AI SDK Types
// ============================================================================

/**
 * AI SDK tool with inputSchema that has a jsonSchema property
 *
 * A regular ai.Tool has inputSchema:FlexibleSchema, but FlexibleSchema does not necessarily have a
 * jsonSchema property. All the tools we use do have a jsonSchema property, and that makes some
 * things simpler down the road.
 */
export type AiToolWithJsonSchema = ai.Tool & {
	inputSchema: ai.Schema;
};

/**
 * Stream parts returned by language model requests
 *
 * Just use the AI SDK v6 type directly. Note that not all platforms (ahem, vscode/positron) emit
 * all the types of stream parts that the AI SDK v6 defines.
 */
export type LMStreamPart = ai.TextStreamPart<Record<string, ai.Tool>>;

// ============================================================================
// Cancellation
// ============================================================================

/**
 * Represents a callback function that handles events.
 */
export type Event<T> = (listener: (e: T) => void) => { dispose(): void };

export interface CancellationToken {
	/**
	 * Is `true` when the token has been cancelled, `false` otherwise.
	 */
	readonly isCancellationRequested: boolean;

	/**
	 * An event which fires upon cancellation.
	 */
	onCancellationRequested: Event<unknown>;
}

// ============================================================================
// Posit AI Auth Metadata
// ============================================================================

export type PositAiModelFetchState = "ok" | "agreement_pending" | "error";

export interface PositAiAuthMetadata extends Record<string, unknown> {
	accountUrl?: string;
	modelFetchState?: PositAiModelFetchState;
	modelFetchStatusCode?: number;
}

// ============================================================================
// Notification Actions
// ============================================================================

export const NOTIFICATION_ACTIONS = {
	/**
	 * Refresh available models - typically triggered when auth errors are cleared
	 * Handler should refetch the availableModels query
	 */
	REFRESH_MODELS: "refresh-models",

	/**
	 * Manage Posit AI account - typically triggered when token balance is low or depleted
	 * Handler should open the Posit AI account management page
	 */
	POSIT_AI_MANAGE_ACCOUNT: "posit-ai-manage-account",

	/**
	 * Complete Posit AI account setup - triggered when user has authenticated but
	 * hasn't signed the user agreement (403 from gateway)
	 * Handler should open the Posit AI setup page
	 */
	POSIT_AI_COMPLETE_SETUP: "posit-ai-complete-setup",
} as const;

/**
 * Type-safe union of all valid notification action IDs
 * Use this type to ensure action IDs are from the valid set
 */
export type NotificationActionId = (typeof NOTIFICATION_ACTIONS)[keyof typeof NOTIFICATION_ACTIONS];

// ============================================================================
// Logger
// ============================================================================

export interface Logger {
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
	debug(message: string, ...args: unknown[]): void;
	trace(message: string, ...args: unknown[]): void;
}
