/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Zod v4 schema for ~/.posit/ai/providers.json.
 *
 * Owns the on-disk format. No secrets ever appear here (API keys, OAuth tokens,
 * AWS secret/session keys live in env vars + the credential store).
 */

import * as z from "zod/v4";

import {
	BUILTIN_PROVIDER_IDS,
	CLIENT_KIND_VALUES,
	isBuiltinProviderId,
	PROTOCOL_VALUES,
	RESERVED_PROVIDER_KEYS,
	SUPPORTED_CUSTOM_CLIENT_KIND_VALUES,
} from "./vocabulary";
import type { BuiltinProviderId, SupportedCustomClientKind } from "./vocabulary";

// ---------------------------------------------------------------------------
// Leaf enums
// ---------------------------------------------------------------------------

export const protocolSchema = z.enum(PROTOCOL_VALUES);

export const clientKindSchema = z.enum(CLIENT_KIND_VALUES);

export const discoverySchema = z.enum(["auto", "off"]);

// ---------------------------------------------------------------------------
// Model overrides + custom models
// ---------------------------------------------------------------------------

/**
 * Partial model metadata patch applied to a model discovery already returns.
 * Every field is optional (lenient) — see `overrides` in the models block.
 */
export const modelOverrideSchema = z
	.object({
		name: z.string().optional(),
		family: z.string().optional(),
		maxContextLength: z.number().int().positive().optional(),
		maxInputTokens: z.number().int().positive().optional(),
		maxOutputTokens: z.number().int().positive().optional(),
		protocol: protocolSchema.optional(),
		baseUrl: z.string().optional(),
		supportsTools: z.boolean().optional(),
		supportsImages: z.boolean().optional(),
		supportsToolResultImages: z.boolean().optional(),
		supportedInputMediaTypes: z.array(z.string()).optional(),
		supportsWebSearch: z.boolean().optional(),
		thinkingEffortLevels: z.array(z.string()).optional(),
	})
	.strict();

/**
 * Complete model definition declared for a model discovery does NOT return.
 * Required fields enforced at schema time (strict) — see `custom` in the
 * models block.
 */
export const customModelSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().min(1),
		maxContextLength: z.number().int().positive(),
		supportsTools: z.boolean(),
		supportsImages: z.boolean(),
		supportsToolResultImages: z.boolean(),
		supportsWebSearch: z.boolean(),
		// Optional metadata
		family: z.string().optional(),
		maxInputTokens: z.number().int().positive().optional(),
		maxOutputTokens: z.number().int().positive().optional(),
		protocol: protocolSchema.optional(),
		baseUrl: z.string().optional(),
		supportedInputMediaTypes: z.array(z.string()).optional(),
		thinkingEffortLevels: z.array(z.string()).optional(),
	})
	.strict();

/**
 * Per-provider model selection block:
 * - `discovery` — query the provider's /models endpoint ("auto") or not ("off").
 * - `allow` — when non-empty, an EXCLUSIVE allowlist of model ids.
 * - `deny` — subtracted from candidates; always wins over `allow`.
 * - `overrides` — partial patches keyed by model id.
 * - `custom` — complete model definitions discovery does not return.
 */
export const modelsBlockSchema = z
	.object({
		discovery: discoverySchema.optional(),
		allow: z.array(z.string()).optional(),
		deny: z.array(z.string()).optional(),
		overrides: z.record(z.string(), modelOverrideSchema).optional(),
		custom: z.array(customModelSchema).optional(),
	})
	.strict();

// ---------------------------------------------------------------------------
// Grouped connection sections (all non-secret)
// ---------------------------------------------------------------------------

/**
 * Posit-login connection config for the built-in `positai` provider.
 *
 * Named `positaiLogin` (not `oauth`) because the engine hard-codes Posit's URL
 * conventions around the bare `host` (device auth / token endpoints, public
 * client, RFC 8628). It is Posit-login config, not generic OAuth — see the
 * `positai` key in {@link BUILTIN_CONNECTION_SECTIONS}.
 */
export const positaiLoginConfigSchema = z
	.object({
		host: z.string().optional(),
		clientId: z.string().optional(),
		scope: z.string().optional(),
	})
	.strict();

/** AWS connection config — secret fields (accessKeyId/secretAccessKey/sessionToken) excluded. */
export const awsConfigSchema = z
	.object({
		region: z.string().optional(),
		profile: z.string().optional(),
	})
	.strict();

export const googleCloudConfigSchema = z
	.object({
		project: z.string().optional(),
		location: z.string().optional(),
	})
	.strict();

export const snowflakeConfigSchema = z
	.object({
		account: z.string().optional(),
		host: z.string().optional(),
	})
	.strict();

/** Per-protocol base-URL overrides (partial — only specified protocols). */
export const endpointsSchema = z.record(protocolSchema, z.string().optional());

// ---------------------------------------------------------------------------
// Connection field composition
// ---------------------------------------------------------------------------

/**
 * Connection fields shared by EVERY provider block (built-in and custom),
 * regardless of provider. Provider-specific capability sub-sections (`aws`,
 * `googleCloud`, `snowflake`, `positaiLogin`) are NOT here — they are attached
 * per-provider via {@link connectionBlockSchema}.
 */
const baseConnectionFields = {
	enabled: z.boolean().optional(),
	baseUrl: z.string().optional(),
	endpoint: z.string().optional(),
	customHeaders: z.record(z.string(), z.string()).optional(),
	protocol: protocolSchema.optional(),
	endpoints: endpointsSchema.optional(),
	models: modelsBlockSchema.optional(),
};

/**
 * The provider-specific connection sub-sections, keyed by section name. A
 * provider block carries only the sub-sections its capability map names.
 */
const CONNECTION_SECTION_SCHEMAS = {
	aws: awsConfigSchema,
	googleCloud: googleCloudConfigSchema,
	snowflake: snowflakeConfigSchema,
	positaiLogin: positaiLoginConfigSchema,
} as const;

/** Name of a provider-specific connection sub-section. */
type ConnectionSectionName = keyof typeof CONNECTION_SECTION_SCHEMAS;

/**
 * Superset of all connection fields (base + every sub-section, all optional).
 * Used for the **enforced** (loose) block shape and the permissive working
 * types — it is not a user-facing strict block.
 */
const allConnectionFields = {
	...baseConnectionFields,
	aws: awsConfigSchema.optional(),
	googleCloud: googleCloudConfigSchema.optional(),
	snowflake: snowflakeConfigSchema.optional(),
	positaiLogin: positaiLoginConfigSchema.optional(),
};

/**
 * Build the `{ section: schema.optional() }` shape for a named set of
 * connection sub-sections. The single internal cast (mirroring the
 * dynamically-keyed provider-map builder below) is safe: the return type is
 * pinned to the precise mapped type the caller relies on.
 */
function connectionSectionShape<S extends ConnectionSectionName>(
	sections: readonly S[],
): { [K in S]: z.ZodOptional<(typeof CONNECTION_SECTION_SCHEMAS)[K]> } {
	const shape: Partial<Record<ConnectionSectionName, z.ZodTypeAny>> = {};
	for (const name of sections) {
		shape[name] = CONNECTION_SECTION_SCHEMAS[name].optional();
	}
	return shape as { [K in S]: z.ZodOptional<(typeof CONNECTION_SECTION_SCHEMAS)[K]> };
}

/**
 * Compose a strict provider block schema from the shared base fields plus the
 * named provider-specific sub-sections. This is the deep helper behind both
 * the per-built-in-key schemas and the custom discriminated-union variants —
 * a block accepts a sub-section only if its capability map names it.
 */
function connectionBlockSchema<S extends ConnectionSectionName>(sections: readonly S[]) {
	return z.object({ ...baseConnectionFields, ...connectionSectionShape(sections) }).strict();
}

// ---------------------------------------------------------------------------
// Capability maps — single source of truth for which sub-sections a provider
// carries. Kept internal to this module; the `satisfies` clauses make a
// missing key a compile error (exhaustiveness), so no export/shape-guard is
// needed for the maps themselves.
// ---------------------------------------------------------------------------

/**
 * Which connection sub-sections each **built-in** provider key carries.
 * Most are base-only; only the four capability-bearing ids name a section.
 * `positaiLogin` attaches to the built-in `positai` key ONLY (no custom
 * variant carries it).
 */
const BUILTIN_CONNECTION_SECTIONS = {
	positai: ["positaiLogin"],
	anthropic: [],
	copilot: [],
	openai: [],
	bedrock: ["aws"],
	gemini: [],
	openrouter: [],
	"google-vertex": ["googleCloud"],
	ollama: [],
	lmstudio: [],
	"openai-compatible": [],
	"snowflake-cortex": ["snowflake"],
	"ms-foundry": [],
	deepseek: [],
} as const satisfies Record<BuiltinProviderId, readonly ConnectionSectionName[]>;

/**
 * Which connection sub-sections each supported **custom** `type` carries. Of
 * the 9 supported kinds only `aws` / `google-vertex` / `snowflake` carry a
 * capability section; the other 6 are base-only. No custom variant carries
 * `positaiLogin`.
 */
const CUSTOM_CONNECTION_SECTIONS = {
	"openai-compatible": [],
	aws: ["aws"],
	snowflake: ["snowflake"],
	"google-vertex": ["googleCloud"],
	ollama: [],
	lmstudio: [],
	deepseek: [],
	openrouter: [],
	"ms-foundry": [],
} as const satisfies Record<SupportedCustomClientKind, readonly ConnectionSectionName[]>;

// ---------------------------------------------------------------------------
// Provider blocks
// ---------------------------------------------------------------------------

/**
 * The permissive **superset** provider block (base + every sub-section, no
 * `type`). This is NOT used in the user-facing `providersMapSchema` — each
 * built-in key there gets its own tailored strict block. It backs the enforced
 * (loose) built-in blocks and the inferred `BuiltinProviderBlock` working type.
 */
export const builtinProviderBlockSchema = z.object(allConnectionFields).strict();

/** The `providers.default` baseline block — carries `enabled` only for v1. */
export const defaultBlockSchema = z
	.object({
		enabled: z.boolean().optional(),
	})
	.strict();

/**
 * A custom provider entry — a genuine discriminated union keyed on `type` (the
 * client kind). Each variant carries only its relevant connection sub-sections.
 * Restricted to the supported 9 kinds (product-specific kinds assume built-in
 * registration and are excluded).
 */
function customProviderVariantSchema<K extends SupportedCustomClientKind>(kind: K) {
	return z
		.object({
			type: z.literal(kind),
			...baseConnectionFields,
			...connectionSectionShape(CUSTOM_CONNECTION_SECTIONS[kind]),
		})
		.strict();
}

export const customProviderEntrySchema = z.discriminatedUnion("type", [
	customProviderVariantSchema("openai-compatible"),
	customProviderVariantSchema("aws"),
	customProviderVariantSchema("snowflake"),
	customProviderVariantSchema("google-vertex"),
	customProviderVariantSchema("ollama"),
	customProviderVariantSchema("lmstudio"),
	customProviderVariantSchema("deepseek"),
	customProviderVariantSchema("openrouter"),
	customProviderVariantSchema("ms-foundry"),
]);

/**
 * Compile-time exhaustiveness guard for the hand-listed variant tuple above.
 *
 * The tuple must be hand-listed (building it with `.map(...)` degrades Zod's
 * discriminated-union type inference), so — unlike `CUSTOM_CONNECTION_SECTIONS`,
 * which is `satisfies Record<SupportedCustomClientKind, …>` — nothing otherwise
 * ties the listed `type` literals to `SUPPORTED_CUSTOM_CLIENT_KIND_VALUES`.
 * Without this, adding a supported kind would fail the section-map guard but
 * could silently omit its variant from the schema (or an extra variant could
 * creep in). This asserts the two sets are exactly equal; a mismatch fails to
 * compile. Type-only — fully erased, no runtime emit.
 */
type CustomVariantKind = z.infer<typeof customProviderEntrySchema>["type"];
type CustomVariantsMatchSupportedKinds = [CustomVariantKind] extends [SupportedCustomClientKind]
	? [SupportedCustomClientKind] extends [CustomVariantKind]
		? true
		: false
	: false;
type AssertTrue<T extends true> = T;
type _AssertCustomVariantsExhaustive = AssertTrue<CustomVariantsMatchSupportedKinds>;

// ---------------------------------------------------------------------------
// Enforced custom provider entry (relaxed `type`, superset sections)
// ---------------------------------------------------------------------------

/**
 * Relaxed variant of `customProviderEntrySchema` for enforced fragments. A
 * discriminated union requires the discriminator, so the enforced entry cannot
 * be one — its connection sections stay a permissive superset. `type` is
 * optional so an admin can enforce a single key (e.g.
 * `providers.custom.my-gateway.enabled = false`) without repeating it; when
 * present it is still constrained to the supported 9 kinds. Full-schema
 * validation happens on the **merged** result, not on the fragment.
 */
export const enforcedCustomProviderEntrySchema = z
	.object({
		type: z.enum(SUPPORTED_CUSTOM_CLIENT_KIND_VALUES).optional(),
		...allConnectionFields,
	})
	.strict();

// ---------------------------------------------------------------------------
// Top-level `providers` map
// ---------------------------------------------------------------------------

/**
 * The `providers` object schema: one optional key per built-in provider id
 * (each a tailored strict block via {@link connectionBlockSchema}), plus the
 * reserved `default` and `custom` keys. `custom` is a discriminated union over
 * the supported client kinds.
 */
/**
 * The runtime schema for a built-in key is its tailored strict block (accepts
 * only that provider's capability sub-sections), but the static type is widened
 * to the permissive superset block. This is the deliberate strict-runtime /
 * superset-static seam: strictness is enforced at **parse time**, while the
 * inferred `ProvidersMap` stays a workable superset — assignable to
 * `EnforcedProvidersMap` and read through the `BuiltinProviderBlock` working
 * type. The single cast bridges the two (there is no subtype relation between
 * two `ZodObject`s with different shapes).
 */
function optionalBuiltinBlock(
	id: BuiltinProviderId,
): z.ZodOptional<typeof builtinProviderBlockSchema> {
	return connectionBlockSchema(
		BUILTIN_CONNECTION_SECTIONS[id],
	).optional() as unknown as z.ZodOptional<typeof builtinProviderBlockSchema>;
}

const builtinProviderKeys = Object.fromEntries(
	BUILTIN_PROVIDER_IDS.map((id) => [id, optionalBuiltinBlock(id)]),
) as Record<BuiltinProviderId, z.ZodOptional<typeof builtinProviderBlockSchema>>;

export const providersMapSchema = z
	.object({
		...builtinProviderKeys,
		default: defaultBlockSchema.optional(),
		custom: z.record(z.string(), customProviderEntrySchema).optional(),
	})
	.strict();

/**
 * Relaxed variant of `providersMapSchema` for enforced fragments. Built-in
 * keys use the permissive superset block (so an enforced fragment can carry a
 * single key without matching a specific provider's tailored shape), and custom
 * entries use `enforcedCustomProviderEntrySchema` (`type` optional).
 */
const enforcedBuiltinProviderKeys = Object.fromEntries(
	BUILTIN_PROVIDER_IDS.map((id) => [id, builtinProviderBlockSchema.optional()]),
) as Record<BuiltinProviderId, z.ZodOptional<typeof builtinProviderBlockSchema>>;

export const enforcedProvidersMapSchema = z
	.object({
		...enforcedBuiltinProviderKeys,
		default: defaultBlockSchema.optional(),
		custom: z.record(z.string(), enforcedCustomProviderEntrySchema).optional(),
	})
	.strict();

// ---------------------------------------------------------------------------
// Root schema
// ---------------------------------------------------------------------------

export const providersConfigSchema = z
	.object({
		$schema: z.string().optional(),
		version: z.literal(1).optional(),
		providers: providersMapSchema.optional(),
	})
	.strict()
	.superRefine((config, ctx) => {
		const custom = config.providers?.custom;
		if (!custom) {
			return;
		}
		for (const name of Object.keys(custom)) {
			if (isBuiltinProviderId(name)) {
				ctx.addIssue({
					code: "custom",
					message: `Custom provider name "${name}" collides with a built-in provider id.`,
					path: ["providers", "custom", name],
				});
			}
			if ((RESERVED_PROVIDER_KEYS as readonly string[]).includes(name)) {
				ctx.addIssue({
					code: "custom",
					message: `Custom provider name "${name}" is a reserved key.`,
					path: ["providers", "custom", name],
				});
			}
		}
	});

/**
 * Relaxed schema for enforced config fragments. Used to validate the
 * `POSIT_AI_PROVIDERS_ENFORCED` env var. Custom provider entries do NOT
 * require the `type` field — full validation happens on the merged result.
 */
export const enforcedProvidersConfigSchema = z
	.object({
		$schema: z.string().optional(),
		version: z.literal(1).optional(),
		providers: enforcedProvidersMapSchema.optional(),
	})
	.strict();
