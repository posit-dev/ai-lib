/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Local vocabulary enums for ai-config.
 *
 * These are defined locally (not imported from ai-provider-bridge) so ai-config
 * remains a dependency-light leaf. A compile-time shape guard in
 * ai-lib/typechecks/ asserts these stay compatible with the bridge.
 */

// ---------------------------------------------------------------------------
// Built-in provider IDs
// ---------------------------------------------------------------------------

/**
 * The set of built-in provider identifiers. Mirrors ai-provider-bridge's
 * PROVIDER_IDS — kept in sync by a shape guard typecheck.
 */
export const BUILTIN_PROVIDER_IDS = [
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

export type BuiltinProviderId = (typeof BUILTIN_PROVIDER_IDS)[number];

const BUILTIN_PROVIDER_ID_SET: ReadonlySet<string> = new Set(BUILTIN_PROVIDER_IDS);

/** Type guard: is `value` a known built-in provider id? */
export function isBuiltinProviderId(value: string): value is BuiltinProviderId {
	return BUILTIN_PROVIDER_ID_SET.has(value);
}

// ---------------------------------------------------------------------------
// Wire protocol enum
// ---------------------------------------------------------------------------

/**
 * API wire-protocol values. These select the message/request format the
 * runtime speaks to a model. Extensible — a value is valid only if a model
 * client can speak it.
 */
export const PROTOCOL_VALUES = [
	"anthropic-messages",
	"openai-chat",
	"openai-responses",
	"bedrock-converse",
	"google-generative",
] as const;

export type Protocol = (typeof PROTOCOL_VALUES)[number];

// ---------------------------------------------------------------------------
// Client-kind enum (for providers.custom `type` discriminator)
// ---------------------------------------------------------------------------

/**
 * Provider client kinds. Each value names a bridge ModelClient implementation
 * that can be instantiated for a custom provider entry.
 */
export const CLIENT_KIND_VALUES = [
	"openai-compatible",
	"aws",
	"snowflake",
	"google-vertex",
	"anthropic",
	"openai",
	"gemini",
	"ollama",
	"lmstudio",
	"deepseek",
	"openrouter",
	"positai",
	"copilot",
	"ms-foundry",
] as const;

export type ClientKind = (typeof CLIENT_KIND_VALUES)[number];

// ---------------------------------------------------------------------------
// Supported custom client kinds (for providers.custom `type` discriminator)
// ---------------------------------------------------------------------------

/**
 * Client kinds valid as a `providers.custom.<name>.type` discriminator.
 *
 * A **local mirror** of `ai-credentials/types`'
 * `SUPPORTED_CUSTOM_CLIENT_KIND_VALUES`. ai-config must not import
 * `ai-credentials` (leaf-import discipline), so the list is duplicated here and
 * a compile-time shape guard in `ai-lib/typechecks/` asserts the two lists are
 * **equal**.
 *
 * This is a strict subset of {@link CLIENT_KIND_VALUES}: product-specific kinds
 * (`positai`, `anthropic`, `openai`, `gemini`, `copilot`) assume built-in
 * registration and are excluded — a custom provider proxying those APIs uses
 * `openai-compatible`.
 */
export const SUPPORTED_CUSTOM_CLIENT_KIND_VALUES = [
	"openai-compatible",
	"aws",
	"snowflake",
	"google-vertex",
	"ollama",
	"lmstudio",
	"deepseek",
	"openrouter",
	"ms-foundry",
] as const;

export type SupportedCustomClientKind = (typeof SUPPORTED_CUSTOM_CLIENT_KIND_VALUES)[number];

// ---------------------------------------------------------------------------
// Reserved keys in the providers map
// ---------------------------------------------------------------------------

/**
 * Keys in the `providers` object that are reserved and cannot be used as
 * custom provider names or collide with built-in provider ids.
 */
export const RESERVED_PROVIDER_KEYS = ["default", "custom"] as const;

export type ReservedProviderKey = (typeof RESERVED_PROVIDER_KEYS)[number];
