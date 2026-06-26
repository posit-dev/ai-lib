/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Zod v4 schema for ~/.posit/genai/providers.json.
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
} from "./vocabulary";

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

export const oauthConfigSchema = z
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

/** Connection fields shared by built-in and custom provider blocks. */
const connectionFields = {
	enabled: z.boolean().optional(),
	baseUrl: z.string().optional(),
	endpoint: z.string().optional(),
	customHeaders: z.record(z.string(), z.string()).optional(),
	protocol: protocolSchema.optional(),
	endpoints: endpointsSchema.optional(),
	oauth: oauthConfigSchema.optional(),
	aws: awsConfigSchema.optional(),
	googleCloud: googleCloudConfigSchema.optional(),
	snowflake: snowflakeConfigSchema.optional(),
	models: modelsBlockSchema.optional(),
};

// ---------------------------------------------------------------------------
// Provider blocks
// ---------------------------------------------------------------------------

/**
 * A built-in provider block. Note: NO `type` field — `type` is custom-only
 * (decision #16). Built-ins carry their client kind implicitly via the bridge
 * registry.
 */
export const builtinProviderBlockSchema = z.object(connectionFields).strict();

/** The `providers.default` baseline block — carries `enabled` only for v1. */
export const defaultBlockSchema = z
	.object({
		enabled: z.boolean().optional(),
	})
	.strict();

/**
 * A custom provider entry. `type` (client kind) is REQUIRED and selects which
 * bridge client to instantiate.
 */
export const customProviderEntrySchema = z
	.object({
		type: clientKindSchema,
		...connectionFields,
	})
	.strict();

// ---------------------------------------------------------------------------
// Top-level `providers` map
// ---------------------------------------------------------------------------

/**
 * Build the `providers` object schema: one optional key per built-in provider
 * id, plus the reserved `default` and `custom` keys.
 */
const builtinProviderKeys = Object.fromEntries(
	BUILTIN_PROVIDER_IDS.map((id) => [id, builtinProviderBlockSchema.optional()]),
) as Record<
	(typeof BUILTIN_PROVIDER_IDS)[number],
	z.ZodOptional<typeof builtinProviderBlockSchema>
>;

export const providersMapSchema = z
	.object({
		...builtinProviderKeys,
		default: defaultBlockSchema.optional(),
		custom: z.record(z.string(), customProviderEntrySchema).optional(),
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
