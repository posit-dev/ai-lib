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

// An env var name, or a list of names consulted in order (first set wins)
// so legacy fallbacks stay subordinate to the primary name.
type EnvNames = string | readonly string[];

/**
 * Maps environment variable names to non-secret connection fields for a
 * built-in provider.
 *
 * Only non-secret connection config goes here. Secret env vars (API keys,
 * AWS secret keys) are handled by the separate `envCredentialResolver` in
 * `@assistant/node`.
 */
interface ConnectionEnvMapping {
	baseUrl?: EnvNames;
	endpoint?: EnvNames;
	positaiLogin?: { host?: EnvNames; clientId?: EnvNames; scope?: EnvNames };
	aws?: { region?: EnvNames; profile?: EnvNames };
	googleCloud?: { project?: EnvNames; location?: EnvNames };
	snowflake?: { account?: EnvNames; host?: EnvNames; home?: EnvNames };
	databricks?: { host?: EnvNames };
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
		baseUrl: "GOOGLE_VERTEX_BASE_URL",
		googleCloud: {
			project: ["GOOGLE_CLOUD_PROJECT", "GOOGLE_VERTEX_PROJECT"],
			location: ["GOOGLE_CLOUD_LOCATION", "GOOGLE_VERTEX_LOCATION"],
		},
	},
	"openai-compatible": { baseUrl: "OPENAI_COMPATIBLE_BASE_URL" },
	"ms-foundry": { baseUrl: "MS_FOUNDRY_BASE_URL" },
	"snowflake-cortex": {
		baseUrl: "SNOWFLAKE_BASE_URL",
		snowflake: { account: "SNOWFLAKE_ACCOUNT", host: "SNOWFLAKE_HOST", home: "SNOWFLAKE_HOME" },
	},
	deepseek: { baseUrl: "DEEPSEEK_BASE_URL" },
	// The standard Databricks CLI/SDK variable. Maps into the `databricks`
	// section (NOT baseUrl): the workspace host is not a chat base URL — the
	// bridge derives the serving-endpoints / AI Gateway URL from it.
	databricks: { databricks: { host: "DATABRICKS_HOST" } },
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
			const val = readEnv(mapping.baseUrl, envVars);
			if (val) block.baseUrl = val;
		}
		if (mapping.endpoint) {
			const val = readEnv(mapping.endpoint, envVars);
			if (val) block.endpoint = val;
		}

		const positaiLogin = mapping.positaiLogin && readEnvSection(mapping.positaiLogin, envVars);
		if (positaiLogin) block.positaiLogin = positaiLogin;

		const aws = mapping.aws && readEnvSection(mapping.aws, envVars);
		if (aws) block.aws = aws;

		const googleCloud = mapping.googleCloud && readEnvSection(mapping.googleCloud, envVars);
		if (googleCloud) block.googleCloud = googleCloud;

		const snowflake = mapping.snowflake && readEnvSection(mapping.snowflake, envVars);
		if (snowflake) block.snowflake = snowflake;

		const databricks = mapping.databricks && readEnvSection(mapping.databricks, envVars);
		if (databricks) block.databricks = databricks;

		if (Object.keys(block).length > 0) providers[id] = block;
	}
	return { providers };
}

/**
 * Read the first set env var among `names`, consulted in order so legacy
 * fallback names stay subordinate to the primary name.
 */
function readEnv(names: EnvNames, envVars: Record<string, string | undefined>): string | undefined {
	const candidates = typeof names === "string" ? [names] : names;
	for (const name of candidates) {
		const val = envVars[name];
		if (val) return val;
	}
	return undefined;
}

/**
 * Read a nested env-mapping section (e.g. `{ host: "ENV_VAR_NAME", ... }`)
 * and return an object with only the fields whose env vars are set.
 * Returns `undefined` if no env vars in the section are set.
 */
function readEnvSection<T extends Record<string, EnvNames | undefined>>(
	mapping: T,
	envVars: Record<string, string | undefined>,
): Record<string, string> | undefined {
	let result: Record<string, string> | undefined;
	for (const [field, envVarNames] of Object.entries(mapping)) {
		if (!envVarNames) continue;
		const val = readEnv(envVarNames, envVars);
		if (val) {
			result ??= {};
			result[field] = val;
		}
	}
	return result;
}
