/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Load and enforce providers.json.
 *
 * Internal building block of `loadResolvedProviderCatalog()`. The catalog is
 * the public read seam; this function need not be exported unless a non-catalog
 * consumer genuinely needs raw enforced config.
 */

import { promises as fs } from "fs";

import { mergeEnforced } from "../enforce";
import { enforcedProvidersConfigSchema, providersConfigSchema } from "../schema";
import type { EnforcedProvidersConfig, ProvidersConfig } from "../types";
import { ENFORCED_ENV_VAR, PROVIDERS_CONFIG_PATH } from "./paths";
import type { EnforcedConfig, LoggerLike } from "./types";

/**
 * Read ~/.posit/genai/providers.json, validate it, apply the env-injected
 * enforced fragment (POSIT_GENAI_PROVIDERS_ENFORCED), and return the
 * **enforced result** (decision #6) — never the raw file.
 *
 * Returns an empty `ProvidersConfig` if the file doesn't exist (valid — a
 * missing file is equivalent to `{}`).
 *
 * Validation warnings are logged but do not throw — the config degrades
 * gracefully to `{}` on errors so consumers are never stranded.
 */
export async function loadProvidersConfig(opts?: {
	configPath?: string;
	enforcedEnvVar?: string;
	logger?: LoggerLike;
}): Promise<EnforcedConfig> {
	const configPath = opts?.configPath ?? PROVIDERS_CONFIG_PATH;
	const enforcedEnvVar = opts?.enforcedEnvVar ?? ENFORCED_ENV_VAR;
	const logger = opts?.logger;

	// 1. Read the file
	const userConfig = await readAndValidateConfig(configPath, logger);

	// 2. Read the enforced fragment from environment
	const enforcedConfig = readEnforcedFragment(enforcedEnvVar, logger);

	// 3. Merge enforced over user
	if (!enforcedConfig) {
		return { userConfig, enforcedConfig: undefined, mergedConfig: userConfig };
	}

	const mergeCandidate = mergeEnforced(userConfig, enforcedConfig);

	// 4. Re-validate merged result with the full schema. The enforced
	// fragment uses a relaxed schema (custom entry `type` optional), so the
	// merge can produce an invalid config — e.g. a custom entry with no
	// `type`. Custom-name collision checks also only run on the full schema.
	// On failure, ignore the enforced fragment and fall back to user config.
	const mergeResult = providersConfigSchema.safeParse(mergeCandidate);
	if (!mergeResult.success) {
		logger?.warn(
			`[ai-config] Enforced config produces an invalid merged result: ${formatZodErrors(mergeResult.error)}. Ignoring enforced config.`,
		);
		return { userConfig, enforcedConfig: undefined, mergedConfig: userConfig };
	}

	return { userConfig, enforcedConfig, mergedConfig: mergeResult.data };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read and validate the config file. Returns `{}` on missing or invalid file.
 */
async function readAndValidateConfig(
	configPath: string,
	logger: LoggerLike | undefined,
): Promise<ProvidersConfig> {
	let raw: string;
	try {
		raw = await fs.readFile(configPath, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			// File doesn't exist — valid, equivalent to empty config
			return {};
		}
		logger?.warn(`[ai-config] Failed to read ${configPath}: ${errorMessage(error)}`);
		return {};
	}

	// Parse JSON
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		logger?.warn(
			`[ai-config] Failed to parse ${configPath} as JSON: ${errorMessage(error)}. Using empty config.`,
		);
		return {};
	}

	// Validate with Zod
	const result = providersConfigSchema.safeParse(parsed);
	if (!result.success) {
		logger?.warn(
			`[ai-config] Validation errors in ${configPath}: ${formatZodErrors(result.error)}. Using empty config.`,
		);
		return {};
	}

	return result.data;
}

/**
 * Read the enforced fragment from an environment variable.
 * Returns `undefined` if the variable is not set or contains invalid JSON/schema.
 *
 * Uses `enforcedProvidersConfigSchema` which relaxes the custom entry `type`
 * field to optional, so an admin can enforce a single key on a custom provider
 * (e.g. `providers.custom.foo.enabled`) without repeating `type`. The merged
 * result is re-validated with the full schema before being returned.
 */
function readEnforcedFragment(
	envVarName: string,
	logger: LoggerLike | undefined,
): EnforcedProvidersConfig | undefined {
	const envValue = process.env[envVarName];
	if (!envValue) {
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(envValue);
	} catch (error) {
		logger?.warn(
			`[ai-config] Failed to parse ${envVarName} as JSON: ${errorMessage(error)}. Ignoring enforced config.`,
		);
		return undefined;
	}

	// Validate with the relaxed enforced schema (custom entry `type` not
	// required — the full schema is checked on the merged result)
	const result = enforcedProvidersConfigSchema.safeParse(parsed);
	if (!result.success) {
		logger?.warn(
			`[ai-config] Validation errors in ${envVarName}: ${formatZodErrors(result.error)}. Ignoring enforced config.`,
		);
		return undefined;
	}

	return result.data;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatZodErrors(error: { issues: Array<{ message: string; path?: unknown[] }> }): string {
	return error.issues.map((i) => `${i.path?.join(".") ?? ""}: ${i.message}`).join("; ");
}
