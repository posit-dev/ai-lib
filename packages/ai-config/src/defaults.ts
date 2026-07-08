/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider connection defaults — the single source of truth.
 *
 * Defines the built-in default connection config for providers that need one.
 * These are used by the catalog builder and (via re-export) by @assistant/node's
 * configMapper and schema validation.
 */

import type { ResolvedConnection } from "./types";
import type { BuiltinProviderId } from "./vocabulary";

/** Posit AI gateway defaults. */
export const POSIT_AI_DEFAULTS = {
	baseUrl: "https://gateway.posit.ai",
	positaiLogin: {
		host: "login.posit.cloud",
		clientId: "rstudio-ide",
		scope: "prism",
	},
} as const satisfies ResolvedConnection;

/** Ollama default endpoint. */
export const OLLAMA_DEFAULTS = {
	endpoint: "http://localhost:11434",
} as const satisfies ResolvedConnection;

/**
 * LM Studio default endpoint. Bare server root — LMStudioClient and the
 * model fetcher append the `/v1` path segment themselves.
 */
export const LMSTUDIO_DEFAULTS = {
	endpoint: "http://localhost:1234",
} as const satisfies ResolvedConnection;

/** AWS Bedrock default region. */
export const BEDROCK_DEFAULTS = {
	aws: { region: "us-east-1" },
} as const satisfies ResolvedConnection;

/** Google Vertex AI default location. */
export const GOOGLE_VERTEX_DEFAULTS = {
	googleCloud: { location: "us-central1" },
} as const satisfies ResolvedConnection;

/**
 * Map of built-in provider id → connection defaults.
 * Only providers that need non-empty defaults appear here.
 */
export const PROVIDER_CONNECTION_DEFAULTS: Readonly<
	Partial<Record<BuiltinProviderId, ResolvedConnection>>
> = {
	positai: POSIT_AI_DEFAULTS,
	ollama: OLLAMA_DEFAULTS,
	lmstudio: LMSTUDIO_DEFAULTS,
	bedrock: BEDROCK_DEFAULTS,
	"google-vertex": GOOGLE_VERTEX_DEFAULTS,
};
