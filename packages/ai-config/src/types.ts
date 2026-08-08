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

import { customProviderNameIssues } from "./custom-provider-name.js";
import type {
	builtinProviderBlockSchema,
	customModelSchema,
	customProviderEntrySchema,
	defaultBlockSchema,
	providersConfigFragmentSchema,
	providersMapFragmentSchema,
	modelOverrideSchema,
	modelsBlockSchema,
	providersConfigSchema,
	providersMapSchema,
} from "./schema.js";
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
 * A partial config fragment — the shape every catalog config source carries.
 * Identical to `ProvidersConfig` except custom provider entries have `type`
 * optional, so a fragment (e.g. an admin-enforced overlay) can set a single
 * key without repeating the full entry. The merged result is re-validated
 * with the full schema before use.
 */
export type ProvidersConfigFragment = z.infer<typeof providersConfigFragmentSchema>;

/**
 * The `providers` map of a config fragment. Identical to `ProvidersMap`
 * except custom entries have `type` optional.
 */
export type ProvidersMapFragment = z.infer<typeof providersMapFragmentSchema>;

// ---------------------------------------------------------------------------
// Branded custom provider id
// ---------------------------------------------------------------------------

declare const __customProviderId: unique symbol;

/**
 * A custom provider id — a string branded to prevent collapse to `string`
 * when unioned with `BuiltinProviderId`. Produced only by
 * `mintCustomProviderId()` after custom-name policy validation.
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
 * and reserved-key collision rules and rejects the unsafe object key
 * `__proto__`; throws if the id is invalid.
 */
export function mintCustomProviderId(id: string): CustomProviderId {
	if (!id) {
		throw new Error("Custom provider id must be a non-empty string.");
	}
	const issue = customProviderNameIssues(id)[0];
	if (issue) {
		throw new Error(issue.replace("Custom provider name", "Custom provider id"));
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
	snowflake?: { account?: string; host?: string; home?: string; connectionName?: string };
	databricks?: { host?: string };
}

/**
 * Semantic origin of a resolved connection value.
 *
 * `configuration` means a non-ambient source (user, legacy, admin, or
 * defaults) explicitly supplied the effective value. `environment` means the
 * ambient connection-env layer is the only source of that value.
 */
export type ResolvedConnectionValueProvenance = "configuration" | "environment";

/**
 * Provenance retained for connection fields whose origin affects consumers.
 * Kept separate from `ResolvedConnection` so metadata can never be spread into
 * a provider client's runtime connection options by accident.
 */
export interface ResolvedConnectionProvenance {
	readonly aws?: {
		readonly region?: ResolvedConnectionValueProvenance;
	};
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

	/** Origin metadata for connection fields whose source affects behavior. */
	readonly connectionProvenance: ResolvedConnectionProvenance;

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
	/** Whether the model requires vLLM-style `chat_template_kwargs` to enable thinking. */
	requiresChatTemplateKwargs?: boolean;
}

/**
 * The complete capability set the model-capability helpers can infer for a
 * model known only by provider and id. Derived from {@link ModelInfoLike} so
 * the package keeps a single ModelInfo mirror: identity/routing fields are
 * dropped, and `protocol` is narrowed to the canonical {@link Protocol} union
 * (set only where inference determines the wire protocol — Snowflake).
 */
export type InferredModelCapabilities = Omit<
	ModelInfoLike,
	"id" | "name" | "baseUrl" | "protocol"
> & {
	protocol?: Protocol;
};

/**
 * Output of `resolveModels()` — a model with resolved routing information.
 * Extends the input model with the protocol and endpoint resolved from the
 * full provider + model config context.
 */
export interface ResolvedModelInfo extends ModelInfoLike {
	/** Wire protocol resolved from model → provider → undefined. */
	readonly resolvedProtocol: Protocol | undefined;
	/** Base URL resolved from user model → provider endpoints → discovered model → provider → undefined. */
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
	"baseUrl",
	"supportsTools",
	"supportsImages",
	"supportsToolResultImages",
	"supportedInputMediaTypes",
	"supportsWebSearch",
	"thinkingEffortLevels",
] as const;

/**
 * Config-only routing field names that do not correspond to bridge ModelInfo
 * fields. Currently empty: discovered models can now carry `baseUrl`.
 */
export const MODEL_ROUTING_FIELD_NAMES = [] as const;

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
