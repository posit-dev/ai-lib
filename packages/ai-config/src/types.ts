/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * TypeScript types for ai-config.
 *
 * Inferred from the Zod schema where possible. Additional types for the
 * resolved-provider catalog and the branded custom-provider-id are defined
 * here.
 *
 * DISK FORMAT: these types describe the on-disk providers.json schema.
 * They are defined locally — never imported from ai-provider-bridge — so a
 * bridge type change cannot silently alter what gets written to disk.
 */

import type * as z from "zod/v4";

import type {
	builtinProviderBlockSchema,
	customModelSchema,
	customProviderEntrySchema,
	defaultBlockSchema,
	modelOverrideSchema,
	modelsBlockSchema,
	providersConfigSchema,
	providersMapSchema,
} from "./schema";
import type { BuiltinProviderId, ClientKind, Protocol } from "./vocabulary";

// ---------------------------------------------------------------------------
// Schema-inferred types (on-disk shapes)
// ---------------------------------------------------------------------------

/** Root config — the complete providers.json file. */
export type ProvidersConfig = z.infer<typeof providersConfigSchema>;

/** The `providers` map inside the config file. */
export type ProvidersMap = z.infer<typeof providersMapSchema>;

/** A built-in provider block (no `type` field). */
export type BuiltinProviderBlock = z.infer<typeof builtinProviderBlockSchema>;

/** The `providers.default` baseline block. */
export type DefaultBlock = z.infer<typeof defaultBlockSchema>;

/** A custom provider entry (`type` required). */
export type CustomProviderEntry = z.infer<typeof customProviderEntrySchema>;

/** Partial model metadata patch (for `overrides`). */
export type ModelOverride = z.infer<typeof modelOverrideSchema>;

/** Complete custom model definition (for `custom` array). */
export type CustomModel = z.infer<typeof customModelSchema>;

/** Per-provider model selection block. */
export type ModelsBlock = z.infer<typeof modelsBlockSchema>;

// ---------------------------------------------------------------------------
// Branded custom provider id
// ---------------------------------------------------------------------------

declare const __customProviderId: unique symbol;

/**
 * A custom provider id — a string branded to prevent collapse to `string`
 * when unioned with `BuiltinProviderId`. Produced only by
 * `mintCustomProviderId()` after catalog-membership validation.
 */
export type CustomProviderId = string & { readonly [__customProviderId]: true };

/**
 * A resolved provider id: either a known built-in or a validated custom id.
 * The brand keeps the built-in literal union intact for autocomplete and
 * exhaustiveness checks.
 */
export type ResolvedProviderId = BuiltinProviderId | CustomProviderId;

/**
 * Mint a `CustomProviderId` from a string. This is the **one** sanctioned
 * place that produces the branded type — call it only after validating the
 * id against built-in and reserved-key collision rules.
 */
export function mintCustomProviderId(id: string): CustomProviderId {
	return id as CustomProviderId;
}

// ---------------------------------------------------------------------------
// Resolved provider catalog
// ---------------------------------------------------------------------------

/** Connection config resolved from a provider block. */
export interface ResolvedConnection {
	baseUrl?: string;
	endpoint?: string;
	customHeaders?: Record<string, string>;
	protocol?: Protocol;
	endpoints?: Partial<Record<Protocol, string>>;
	oauth?: { host?: string; clientId?: string; scope?: string };
	aws?: { region?: string; profile?: string };
	googleCloud?: { project?: string; location?: string };
	snowflake?: { account?: string; host?: string };
}

/**
 * A resolved provider entry in the catalog — the uniform shape consumers
 * iterate instead of the static PROVIDER_REGISTRY.
 *
 * Every entry carries a `clientKind` (built-ins get theirs from the registry,
 * custom from the declared `type`), a resolved `enabled` boolean, connection
 * config, and model policy/custom declarations.
 *
 * It does NOT carry discovered models — those need credentials + a runtime
 * fetcher that ai-config cannot hold. Dynamic model resolution stays in
 * `resolveModels(...)`.
 */
export interface ResolvedProvider {
	/** Built-in or custom provider id. */
	readonly id: ResolvedProviderId;

	/** Client implementation to instantiate (e.g. "openai-compatible", "aws"). */
	readonly clientKind: ClientKind;

	/** Whether this provider is enabled after all precedence layers. */
	readonly enabled: boolean;

	/** Resolved non-secret connection config. */
	readonly connection: ResolvedConnection;

	/** Model policy and custom declarations, if configured. */
	readonly models: ModelsBlock | undefined;
}

// ---------------------------------------------------------------------------
// ModelInfoLike — local mirror of overridable ModelInfo fields
// ---------------------------------------------------------------------------

/**
 * Subset of bridge ModelInfo fields that `resolveModels` operates on.
 * Defined locally so the pure entry has no bridge dependency. At the
 * consumption boundary, callers pass real `ModelInfo` objects — this
 * interface is satisfied by them.
 */
export interface ModelInfoLike {
	id: string;
	name: string;
	family?: string;
	maxContextLength: number;
	maxInputTokens?: number;
	maxOutputTokens?: number;
	protocol?: string;
	supportsTools: boolean;
	supportsImages: boolean;
	supportsToolResultImages: boolean;
	supportedInputMediaTypes?: string[];
	supportsWebSearch: boolean;
	thinkingEffortLevels?: string[];
}

/**
 * The names of ModelInfoLike fields that can appear in model overrides.
 * Used by the shape guard to verify these stay a subset of bridge ModelInfo.
 */
export const MODEL_OVERRIDE_FIELD_NAMES = [
	"name",
	"family",
	"maxContextLength",
	"maxInputTokens",
	"maxOutputTokens",
	"protocol",
	"supportsTools",
	"supportsImages",
	"supportsToolResultImages",
	"supportedInputMediaTypes",
	"supportsWebSearch",
	"thinkingEffortLevels",
] as const;

// ---------------------------------------------------------------------------
// Platform baseline
// ---------------------------------------------------------------------------

/**
 * How a platform expresses its enablement defaults.
 *
 * Examples:
 * - Standalone/TUI: `{ defaultEnabled: true }` — all providers enabled by default.
 * - RStudio: `{ defaultEnabled: false, providerOverrides: { positai: { enabled: true } } }`
 */
export interface PlatformBaseline {
	/** Baseline `default.enabled` when neither user nor enforced config provides one. */
	readonly defaultEnabled: boolean;
	/** Per-provider overrides layered over `defaultEnabled`. */
	readonly providerOverrides?: Readonly<Record<string, { enabled: boolean }>>;
}
