/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Read providers.json + env fragments into an ordered stack of
 * `ProviderConfigSource`s.
 *
 * Internal building block of `loadResolvedProviderCatalog()` and
 * `watchResolvedProviderCatalog()`. Precedence is NOT applied here — the pure
 * `resolveProviderCatalog()` seam owns the merge/precedence. This module only
 * turns bytes on disk / env vars into validated source fragments.
 */

import { promises as fs } from "fs";

import type { ProviderConfigSource } from "../resolve-catalog";
import { enforcedProvidersConfigSchema, providersConfigSchema } from "../schema";
import type { EnforcedProvidersConfig, LoggerLike, ProvidersConfig } from "../types";
import { DEFAULT_ENV_VAR, ENFORCED_ENV_VAR, PROVIDERS_CONFIG_PATH } from "./paths";

/** Options for assembling the default config sources. */
export interface LoadConfigSourcesOptions {
	/** Override the config file path (defaults to ~/.posit/ai/providers.json). */
	configPath?: string;
	/** Override the enforced env-var name (defaults to POSIT_AI_PROVIDERS_ENFORCED). */
	enforcedEnvVar?: string;
	/** Override the default env-var name (defaults to POSIT_AI_PROVIDERS_DEFAULT). */
	defaultEnvVar?: string;
	/** Environment variables to read fragments from (defaults to process.env). */
	env?: Record<string, string | undefined>;
	/** Optional logger for diagnostics and validation warnings. */
	logger?: LoggerLike;
}

/**
 * Assemble the default config sources: the user's `providers.json` file, the
 * enforced env overlay, and the default env layer.
 *
 * The returned array is unordered with respect to precedence — each source
 * carries its `kind`, and the resolver ranks them. Env sources are omitted
 * when their env var is unset or fails to parse/validate (with a warning).
 * The user (file) source is **always** present so it can serve as the
 * validated fallback if merged overlays are invalid.
 */
export async function loadConfigSources(
	opts?: LoadConfigSourcesOptions,
): Promise<ProviderConfigSource[]> {
	const configPath = opts?.configPath ?? PROVIDERS_CONFIG_PATH;
	const enforcedEnvVar = opts?.enforcedEnvVar ?? ENFORCED_ENV_VAR;
	const defaultEnvVar = opts?.defaultEnvVar ?? DEFAULT_ENV_VAR;
	const env = opts?.env ?? process.env;
	const logger = opts?.logger;

	const sources: ProviderConfigSource[] = [];

	// user — the validated providers.json (empty config if missing/invalid).
	const userConfig = await readFileConfig(configPath, logger);
	sources.push({ kind: "user", label: configPath, config: userConfig });

	// enforced — the sealed admin overlay.
	const enforced = readEnvFragment(enforcedEnvVar, env, logger);
	if (enforced) {
		sources.push({ kind: "enforced", label: enforcedEnvVar, config: enforced });
	}

	// default — Workbench admin defaults (below user/host).
	const defaults = readEnvFragment(defaultEnvVar, env, logger);
	if (defaults) {
		sources.push({ kind: "default", label: defaultEnvVar, config: defaults });
	}

	return sources;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read and validate the config file. Returns `{}` on missing or invalid file
 * (a missing file is equivalent to an empty config — consumers are never
 * stranded).
 */
export async function readFileConfig(
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
 * Read a config fragment from an environment variable.
 * Returns `undefined` if the variable is not set or contains invalid
 * JSON/schema (with a warning).
 *
 * Uses `enforcedProvidersConfigSchema` which relaxes the custom entry `type`
 * field to optional, so an admin can enforce/default a single key on a custom
 * provider without repeating `type`. The merged result is re-validated with
 * the full schema by the resolver.
 */
export function readEnvFragment(
	envVarName: string,
	env: Record<string, string | undefined>,
	logger: LoggerLike | undefined,
): EnforcedProvidersConfig | undefined {
	const envValue = env[envVarName];
	if (!envValue) {
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(envValue);
	} catch (error) {
		logger?.warn(
			`[ai-config] Failed to parse ${envVarName} as JSON: ${errorMessage(error)}. Ignoring.`,
		);
		return undefined;
	}

	const result = enforcedProvidersConfigSchema.safeParse(parsed);
	if (!result.success) {
		logger?.warn(
			`[ai-config] Validation errors in ${envVarName}: ${formatZodErrors(result.error)}. Ignoring.`,
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
