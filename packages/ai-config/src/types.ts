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
	enforcedProvidersConfigSchema,
	enforcedProvidersMapSchema,
	modelOverrideSchema,
	modelsBlockSchema,
	providersConfigSchema,
	providersMapSchema,
} from "./schema.js";
import { isBuiltinProviderId, RESERVED_PROVIDER_KEYS } from "./vocabulary.js";
import type { BuiltinProviderId, ClientKind, Protocol } from "./vocabulary.js";

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

/**
 * Enforced config type. Identical to `ProvidersConfig` except custom provider
 * entries have `type` optional, so an admin can enforce a single key without
 * repeating the full entry. The merged result is re-validated with the full
 * schema before use.
 */
export type EnforcedProvidersConfig = z.infer<typeof enforcedProvidersConfigSchema>;

/**
 * Enforced providers map. Identical to `ProvidersMap` except custom entries
 * have `type` optional.
 */
export type EnforcedProvidersMap = z.infer<typeof enforcedProvidersMapSchema>;

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
 * place that produces the branded type. Validates the id against built-in
 * and reserved-key collision rules; throws if the id is invalid.
 */
export function mintCustomProviderId(id: string): CustomProviderId {
	if (!id) {
		throw new Error("Custom provider id must be a non-empty string.");
	}
	if (isBuiltinProviderId(id)) {
		throw new Error(`Custom provider id "${id}" collides with a built-in provider id.`);
	}
	if ((RESERVED_PROVIDER_KEYS as readonly string[]).includes(id)) {
		throw new Error(`Custom provider id "${id}" is a reserved key.`);
	}
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
	positaiLogin?: { host?: string; clientId?: string; scope?: string };
	aws?: { region?: string; profile?: string };
	googleCloud?: { project?: string; location?: string };
	snowflake?: { account?: string; host?: string };
	databricks?: { host?: string };
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
	baseUrl?: string;
	supportsTools: boolean;
	supportsImages: boolean;
	supportsToolResultImages: boolean;
	supportedInputMediaTypes?: string[];
	supportsWebSearch: boolean;
	thinkingEffortLevels?: string[];
}

/**
 * Output of `resolveModels()` — a model with resolved routing information.
 * Extends the input model with the protocol and endpoint resolved from the
 * full provider + model config context.
 */
export interface ResolvedModelInfo extends ModelInfoLike {
	/** Wire protocol resolved from model → provider → undefined. */
	readonly resolvedProtocol: Protocol | undefined;
	/** Base URL resolved from model → provider endpoints → provider baseUrl → undefined. */
	readonly resolvedBaseUrl: string | undefined;
}

/**
 * Model metadata field names that appear in overrides AND map to bridge
 * ModelInfo fields. Used by the shape guard to verify these stay a subset
 * of bridge ModelInfo keys.
 */
export const MODEL_METADATA_FIELD_NAMES = [
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

/**
 * Routing-only field names that appear in model overrides/custom definitions
 * but do NOT correspond to bridge ModelInfo fields. These are config-layer
 * routing concerns (endpoint selection) resolved by the pipeline, not model
 * metadata. Not checked by the shape guard.
 */
export const MODEL_ROUTING_FIELD_NAMES = ["baseUrl"] as const;

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

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/**
 * Minimal logger interface used by the resolver and node seams. Matches the
 * subset actually used. Lives in the pure entry so the pure resolver
 * (`resolveProviderCatalog`) can accept a logger without depending on `./node`.
 */
export interface LoggerLike {
	debug(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
}
