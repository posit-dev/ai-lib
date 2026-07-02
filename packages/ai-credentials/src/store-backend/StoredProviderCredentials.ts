/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * StoredProviderCredentials — on-disk format for provider credentials.
 *
 * Defines the shape of data persisted in `~/.posit/genai/auth/data.json`.
 * Guarded by a tolerant Zod schema (runtime validation) rather than a
 * compile-time shape guard.
 *
 * ON-DISK FORMAT: This interface is intentionally independent from the runtime
 * `ProviderCredentials` union in `ai-credentials/types`. The two types can
 * evolve independently. Conversion between them happens in the credential
 * backend.
 *
 * V1 COMPATIBILITY: No stored version field. The Zod schema parses tolerantly
 * (optional fields default as today). `data.json` stays byte-compatible —
 * no new keys, no envelope, no migration. The generic `SingleFileStore` is
 * untouched.
 */

import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Zod schema — tolerant parse (all fields optional)
// ---------------------------------------------------------------------------

const tokenDataSchema = z.object({
	accessToken: z.string(),
	refreshToken: z.string(),
	expiresAt: z.string(),
	tokenType: z.string(),
	scope: z.string(),
});

/**
 * Tolerant Zod schema for a single credential record in data.json.
 *
 * Every field is optional so that existing records (which may have only a
 * subset of fields populated) parse without error. The schema is the safety
 * net replacing the compile-time shape guard in node's
 * `disk-format-shapes.typecheck.ts`.
 */
export const storedProviderCredentialsSchema = z.object({
	// Common fields (all auth methods)
	configured: z.boolean().optional(),
	authenticated: z.boolean().optional(),
	error: z.string().optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),

	// Auth-method-specific fields (only one should be populated)
	apiKeyAuth: z
		.object({
			apiKey: z.string(),
			baseUrl: z.string().optional(),
		})
		.optional(),

	oauthAuth: z
		.object({
			tokenData: tokenDataSchema,
			expiresAt: z.string(),
			scope: z.string(),
		})
		.optional(),

	localAuth: z
		.object({
			endpoint: z.string(),
		})
		.optional(),

	awsAuth: z
		.object({
			region: z.string(),
			profile: z.string().optional(),
			accessKeyId: z.string().optional(),
			secretAccessKey: z.string().optional(),
			sessionToken: z.string().optional(),
		})
		.optional(),

	googleCloudAuth: z
		.object({
			project: z.string(),
			location: z.string(),
		})
		.optional(),
});

/**
 * Generic storage structure for all provider credentials.
 *
 * Different auth methods store different fields, grouped by auth type.
 * Only one auth-specific group should be populated per provider.
 *
 * Inferred from the Zod schema to keep the type and runtime validation
 * in sync.
 */
export type StoredProviderCredentials = z.infer<typeof storedProviderCredentialsSchema>;

/**
 * The expected top-level keys of `StoredProviderCredentials`.
 *
 * Exported for use in compile-time shape guards that verify the record
 * shape hasn't changed unexpectedly.
 */
export type StoredProviderCredentialsKeys = keyof Required<StoredProviderCredentials>;
