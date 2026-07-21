/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Non-secret connection env-var mappings and the reader that converts them
 * into a config source fragment.
 *
 * Internal to ai-config — the env fragment is synthesized inside
 * `resolveProviderCatalog` and ranked below `enforced` so admin-pinned
 * values can never be overridden by a user's shell variables.
 */

import type { BuiltinProviderBlock, EnforcedProvidersConfig } from "./types.js";
import { BUILTIN_PROVIDER_IDS } from "./vocabulary.js";
import type { BuiltinProviderId } from "./vocabulary.js";

// ---------------------------------------------------------------------------
// Non-secret connection env var mappings
// ---------------------------------------------------------------------------

/**
 * Maps environment variable names to non-secret connection fields for a
 * built-in provider.
 *
 * Only non-secret connection config goes here. Secret env vars (API keys,
 * AWS secret keys) are handled by the separate `envCredentialResolver` in
 * `@assistant/node`.
 */
interface ConnectionEnvMapping {
	baseUrl?: string;
	endpoint?: string;
	positaiLogin?: { host?: string; clientId?: string; scope?: string };
	aws?: { region?: string; profile?: string };
	googleCloud?: { project?: string; location?: string };
}

/**
 * Annotated as `Partial<Record<BuiltinProviderId, ...>>` so the reader can
 * iterate `BUILTIN_PROVIDER_IDS` and `continue` on an undefined mapping —
 * no assertion needed, and the provider vocabulary stays the single source
 * of truth.
 */
const CONNECTION_ENV_MAPPINGS: Partial<Record<BuiltinProviderId, ConnectionEnvMapping>> = {
	anthropic: { baseUrl: "ANTHROPIC_BASE_URL" },
	openai: { baseUrl: "OPENAI_BASE_URL" },
	gemini: { baseUrl: "GEMINI_BASE_URL" },
	positai: {
		baseUrl: "POSITAI_BASE_URL",
		positaiLogin: {
			host: "POSITAI_AUTH_HOST",
			clientId: "POSITAI_CLIENT_ID",
			scope: "POSITAI_SCOPE",
		},
	},
	openrouter: { baseUrl: "OPENROUTER_BASE_URL" },
	ollama: { endpoint: "OLLAMA_ENDPOINT" },
	lmstudio: { endpoint: "LMSTUDIO_ENDPOINT" },
	bedrock: { aws: { region: "AWS_REGION", profile: "AWS_PROFILE" } },
	"google-vertex": {
		googleCloud: {
			project: "GOOGLE_CLOUD_PROJECT",
			location: "GOOGLE_CLOUD_LOCATION",
		},
	},
	"openai-compatible": { baseUrl: "OPENAI_COMPATIBLE_BASE_URL" },
	"ms-foundry": { baseUrl: "MS_FOUNDRY_BASE_URL" },
	"snowflake-cortex": { baseUrl: "SNOWFLAKE_BASE_URL" },
	deepseek: { baseUrl: "DEEPSEEK_BASE_URL" },
};

// ---------------------------------------------------------------------------
// Env fragment reader
// ---------------------------------------------------------------------------

/**
 * Read non-secret connection env vars and return them as an
 * `EnforcedProvidersConfig` fragment suitable for insertion into the
 * resolver's precedence stack.
 *
 * The returned fragment carries only connection fields — never enablement.
 * When no env vars are set, the `providers` map is empty (`{}`).
 */
export function readEnvConnectionConfig(
	envVars: Record<string, string | undefined>,
): EnforcedProvidersConfig {
	const providers: Partial<Record<BuiltinProviderId, BuiltinProviderBlock>> = {};
	for (const id of BUILTIN_PROVIDER_IDS) {
		const mapping = CONNECTION_ENV_MAPPINGS[id];
		if (!mapping) continue;

		const block: BuiltinProviderBlock = {};
		if (mapping.baseUrl) {
			const val = envVars[mapping.baseUrl];
			if (val) block.baseUrl = val;
		}
		if (mapping.endpoint) {
			const val = envVars[mapping.endpoint];
			if (val) block.endpoint = val;
		}

		const positaiLogin = mapping.positaiLogin && readEnvSection(mapping.positaiLogin, envVars);
		if (positaiLogin) block.positaiLogin = positaiLogin;

		const aws = mapping.aws && readEnvSection(mapping.aws, envVars);
		if (aws) block.aws = aws;

		const googleCloud = mapping.googleCloud && readEnvSection(mapping.googleCloud, envVars);
		if (googleCloud) block.googleCloud = googleCloud;

		if (Object.keys(block).length > 0) providers[id] = block;
	}
	return { providers };
}

/**
 * Read a nested env-mapping section (e.g. `{ host: "ENV_VAR_NAME", ... }`)
 * and return an object with only the fields whose env vars are set.
 * Returns `undefined` if no env vars in the section are set.
 */
function readEnvSection<T extends Record<string, string | undefined>>(
	mapping: T,
	envVars: Record<string, string | undefined>,
): Record<string, string> | undefined {
	let result: Record<string, string> | undefined;
	for (const [field, envVarName] of Object.entries(mapping)) {
		if (!envVarName) continue;
		const val = envVars[envVarName];
		if (val) {
			result ??= {};
			result[field] = val;
		}
	}
	return result;
}
