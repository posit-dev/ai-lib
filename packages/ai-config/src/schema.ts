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

import { customProviderNameIssues } from "./custom-provider-name.js";
import { validateUnsafeObjectKeys } from "./unsafe-object-key.js";
import {
	BUILTIN_PROVIDER_IDS,
	CLIENT_KIND_VALUES,
	PROTOCOL_VALUES,
	SUPPORTED_CUSTOM_CLIENT_KIND_VALUES,
} from "./vocabulary.js";
import type { BuiltinProviderId, SupportedCustomClientKind } from "./vocabulary.js";

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
 * Complete model definition declared for a model discovery does NOT return, or
 * to replace metadata for a discovered model with the same id. Required fields
 * are enforced at schema time (strict) — see `custom` in the models block.
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
 * - `custom` — complete model definitions discovery does not return, or same-id replacements.
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

/**
 * Microsoft Entra ID auth mode for the built-in `ms-foundry` provider.
 * Absent `authMode` resolves to `"apikey"` (back-compat); see
 * `MS_FOUNDRY_DEFAULTS` in defaults.ts.
 */
export const azureAuthModeSchema = z.enum(["apikey", "entra"]);

/**
 * Azure / Microsoft Entra ID connection config for `ms-foundry` — all
 * non-secret. Entra tokens are acquired at runtime by `@azure/identity`
 * (DefaultAzureCredential); nothing secret is ever stored here.
 */
export const azureConfigSchema = z
	.object({
		authMode: azureAuthModeSchema.optional(),
		scope: z.string().optional(),
		tenantId: z.string().optional(),
	})
	.strict();

export const snowflakeConfigSchema = z
	.object({
		account: z.string().optional(),
		host: z.string().optional(),
		/**
		 * Directory containing `connections.toml` (the `SNOWFLAKE_HOME` override).
		 * Points Snowflake credential discovery at a non-default location — e.g.
		 * Workbench Managed Credentials, which place `connections.toml` in a
		 * managed directory. Non-secret.
		 */
		home: z.string().optional(),
		/**
		 * Name of the `connections.toml` connection to use (non-secret). Selects
		 * one entry from the file `home` points at. Consumed by
		 * `@assistant/node`'s Snowflake resolver on Node platforms; ignored in
		 * Positron, which defers Snowflake credentials to `vscode.authentication`.
		 */
		connectionName: z.string().optional(),
	})
	.strict();

/**
 * Databricks workspace host (NOT a chat base URL — the bridge derives the
 * serving-endpoints / AI Gateway URL from it). Kept out of `baseUrl` so the
 * per-model endpoint resolution never routes chat to the bare host.
 */
export const databricksConfigSchema = z
	.object({
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

const GATEWAY_RESERVED_AUTH_HEADERS = {
	litellm: new Set(["authorization", "x-api-key"]),
	portkey: new Set(["authorization", "x-api-key", "x-portkey-api-key", "x-portkey-virtual-key"]),
} as const satisfies Partial<Record<BuiltinProviderId, ReadonlySet<string>>>;

function gatewayCustomHeadersSchema(providerId: BuiltinProviderId) {
	const reserved =
		providerId === "litellm"
			? GATEWAY_RESERVED_AUTH_HEADERS.litellm
			: providerId === "portkey"
				? GATEWAY_RESERVED_AUTH_HEADERS.portkey
				: undefined;
	const schema = z.record(z.string(), z.string());
	if (!reserved) return schema;
	return schema.superRefine((headers, ctx) => {
		for (const name of Object.keys(headers)) {
			if (reserved.has(name.toLowerCase())) {
				ctx.addIssue({
					code: "custom",
					message: `Authentication header "${name}" is reserved and cannot be set in customHeaders.`,
					path: [name],
				});
			}
		}
	});
}

/**
 * The provider-specific connection sub-sections, keyed by section name. A
 * provider block carries only the sub-sections its capability map names.
 */
const CONNECTION_SECTION_SCHEMAS = {
	aws: awsConfigSchema,
	azure: azureConfigSchema,
	googleCloud: googleCloudConfigSchema,
	snowflake: snowflakeConfigSchema,
	databricks: databricksConfigSchema,
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
	azure: azureConfigSchema.optional(),
	googleCloud: googleCloudConfigSchema.optional(),
	snowflake: snowflakeConfigSchema.optional(),
	databricks: databricksConfigSchema.optional(),
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
function connectionBlockSchema<S extends ConnectionSectionName>(
	providerId: BuiltinProviderId,
	sections: readonly S[],
) {
	return z
		.object({
			...baseConnectionFields,
			customHeaders: gatewayCustomHeadersSchema(providerId).optional(),
			...connectionSectionShape(sections),
		})
		.strict();
}

// ---------------------------------------------------------------------------
// Capability maps — single source of truth for which sub-sections a provider
// carries. Kept internal to this module; the `satisfies` clauses make a
// missing key a compile error (exhaustiveness), so no export/shape-guard is
// needed for the maps themselves.
// ---------------------------------------------------------------------------

/**
 * Which connection sub-sections each **built-in** provider key carries.
 * Most are base-only; only the capability-bearing ids name a section.
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
	"ms-foundry": ["azure"],
	deepseek: [],
	databricks: ["databricks"],
	litellm: [],
	portkey: [],
	"posit-connect": [],
} as const satisfies Record<BuiltinProviderId, readonly ConnectionSectionName[]>;

/**
 * Which connection sub-sections each supported **custom** `type` carries.
 * Only `aws` / `google-vertex` / `snowflake` carry a capability section; all
 * other supported kinds are base-only. No custom variant carries
 * `positaiLogin`.
 */
const CUSTOM_CONNECTION_SECTIONS = {
	"openai-compatible": [],
	anthropic: [],
	openai: [],
	gemini: [],
	aws: ["aws"],
	snowflake: ["snowflake"],
	"google-vertex": ["googleCloud"],
	ollama: [],
	lmstudio: [],
	deepseek: [],
	openrouter: [],
	"ms-foundry": [],
	litellm: [],
	portkey: [],
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
 * Restricted to the supported kinds (product-specific kinds assume built-in
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
	customProviderVariantSchema("anthropic"),
	customProviderVariantSchema("openai"),
	customProviderVariantSchema("gemini"),
	customProviderVariantSchema("aws"),
	customProviderVariantSchema("snowflake"),
	customProviderVariantSchema("google-vertex"),
	customProviderVariantSchema("ollama"),
	customProviderVariantSchema("lmstudio"),
	customProviderVariantSchema("deepseek"),
	customProviderVariantSchema("openrouter"),
	customProviderVariantSchema("ms-foundry"),
	customProviderVariantSchema("litellm"),
	customProviderVariantSchema("portkey"),
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
// Custom provider entry fragment (relaxed `type`, superset sections)
// ---------------------------------------------------------------------------

/**
 * Relaxed variant of `customProviderEntrySchema` for config fragments. A
 * discriminated union requires the discriminator, so the fragment entry cannot
 * be one — its connection sections stay a permissive superset. `type` is
 * optional so a fragment can set a single key (e.g. an admin enforcing
 * `providers.custom.my-gateway.enabled = false`) without repeating it; when
 * present it is still constrained to the supported kinds. Full-schema
 * validation happens on the **merged** result, not on the fragment.
 */
export const customProviderEntryFragmentSchema = z
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
 * `ProvidersMapFragment` and read through the `BuiltinProviderBlock` working
 * type. The single cast bridges the two (there is no subtype relation between
 * two `ZodObject`s with different shapes).
 */
/**
 * Canonical strict validator for each built-in provider block. Kept out of
 * the package entrypoint, but shared by the full schema and tolerant salvage
 * so adding a built-in id cannot make those paths disagree.
 */
export const builtinProviderBlockSchemas = Object.fromEntries(
	BUILTIN_PROVIDER_IDS.map((id) => [
		id,
		connectionBlockSchema(id, BUILTIN_CONNECTION_SECTIONS[id]),
	]),
) as Record<BuiltinProviderId, typeof builtinProviderBlockSchema>;

function optionalBuiltinBlock(
	id: BuiltinProviderId,
): z.ZodOptional<typeof builtinProviderBlockSchema> {
	return builtinProviderBlockSchemas[id].optional();
}

const builtinProviderKeys = Object.fromEntries(
	BUILTIN_PROVIDER_IDS.map((id) => [id, optionalBuiltinBlock(id)]),
) as Record<BuiltinProviderId, z.ZodOptional<typeof builtinProviderBlockSchema>>;

function validateCustomProviderNames(value: unknown, ctx: z.RefinementCtx): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return value;
	}
	for (const name of Object.keys(value)) {
		for (const message of customProviderNameIssues(name)) {
			ctx.addIssue({ code: "custom", message, path: [name] });
		}
	}
	return value;
}

export const providersMapSchema = z
	.object({
		...builtinProviderKeys,
		default: defaultBlockSchema.optional(),
		custom: z
			.preprocess(validateCustomProviderNames, z.record(z.string(), customProviderEntrySchema))
			.optional(),
	})
	.strict();

/**
 * Relaxed variant of `providersMapSchema` for config fragments. Built-in
 * keys use the permissive superset block (so a fragment can carry a
 * single key without matching a specific provider's tailored shape), and custom
 * entries use `customProviderEntryFragmentSchema` (`type` optional).
 */
const fragmentBuiltinProviderKeys = Object.fromEntries(
	BUILTIN_PROVIDER_IDS.map((id) => [id, builtinProviderBlockSchema.optional()]),
) as Record<BuiltinProviderId, z.ZodOptional<typeof builtinProviderBlockSchema>>;

export const providersMapFragmentSchema = z
	.object({
		...fragmentBuiltinProviderKeys,
		default: defaultBlockSchema.optional(),
		custom: z
			.preprocess(
				validateCustomProviderNames,
				z.record(z.string(), customProviderEntryFragmentSchema),
			)
			.optional(),
	})
	.strict();

// ---------------------------------------------------------------------------
// Root schema
// ---------------------------------------------------------------------------

export const providersConfigSchema = z.preprocess(
	validateUnsafeObjectKeys,
	z
		.object({
			$schema: z.string().optional(),
			version: z.literal(1).optional(),
			providers: providersMapSchema.optional(),
		})
		.strict(),
);

/**
 * Relaxed schema for partial config fragments — the shape every catalog
 * config source carries (the `POSIT_AI_PROVIDERS_ENFORCED` /
 * `POSIT_AI_PROVIDERS_DEFAULT` env fragments, the legacy Positron layers,
 * connection env vars). Custom provider entries do NOT require the `type`
 * field — full validation happens on the merged result.
 */
export const providersConfigFragmentSchema = z.preprocess(
	validateUnsafeObjectKeys,
	z
		.object({
			$schema: z.string().optional(),
			version: z.literal(1).optional(),
			providers: providersMapFragmentSchema.optional(),
		})
		.strict(),
);
