/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/** Read providers.json and env fragments into structured source reports. */

import { promises as fs } from "fs";

import { configIssuePath, formatConfigIssue, sourceConfigIssue } from "../config-issue.js";
import type { ConfigIssue, SourcedConfigIssue } from "../config-issue.js";
import type { ProviderConfigSourceReadReport } from "../config-source.js";
import type { ProviderConfigSource } from "../resolve-catalog.js";
import { providersConfigFragmentSchema } from "../schema.js";
import type { LoggerLike } from "../types.js";
import { parseProvidersConfigTolerant } from "./parse-providers-config.js";
import { DEFAULT_ENV_VAR, ENFORCED_ENV_VAR, PROVIDERS_CONFIG_PATH } from "./paths.js";

export interface LoadConfigSourcesOptions {
	readonly configPath?: string;
	readonly enforcedEnvVar?: string;
	readonly defaultEnvVar?: string;
	readonly env?: Record<string, string | undefined>;
	readonly logger?: LoggerLike;
}

/** Assemble complete read reports without rendering diagnostics. */
export async function loadConfigSourceReports(
	opts?: LoadConfigSourcesOptions,
): Promise<ProviderConfigSourceReadReport[]> {
	const configPath = opts?.configPath ?? PROVIDERS_CONFIG_PATH;
	const enforcedEnvVar = opts?.enforcedEnvVar ?? ENFORCED_ENV_VAR;
	const defaultEnvVar = opts?.defaultEnvVar ?? DEFAULT_ENV_VAR;
	const env = opts?.env ?? process.env;

	return [
		await readFileConfig(configPath),
		readEnvFragment("enforced", enforcedEnvVar, env),
		readEnvFragment("default", defaultEnvVar, env),
	];
}

/** Compatibility wrapper retaining the historical bare-source signature. */
export async function loadConfigSources(
	opts?: LoadConfigSourcesOptions,
): Promise<ProviderConfigSource[]> {
	const reports = await loadConfigSourceReports(opts);
	for (const issue of reports.flatMap((report) => report.issues)) {
		opts?.logger?.warn(formatConfigIssue(issue));
	}
	return reports.flatMap((report) => (report.source ? [report.source] : []));
}

/** Read the user file tolerantly. Missing is a healthy empty user source. */
export async function readFileConfig(configPath: string): Promise<ProviderConfigSourceReadReport> {
	const identity = { kind: "user", label: configPath } satisfies Pick<
		ProviderConfigSource,
		"kind" | "label"
	>;
	let raw: string;
	try {
		raw = await fs.readFile(configPath, "utf-8");
	} catch (error) {
		if (isErrnoCode(error, "ENOENT")) {
			return { source: { ...identity, config: {} }, issues: [] };
		}
		return {
			source: { ...identity, config: {} },
			issues: [
				sourceConfigIssue(
					warning([], `Failed to read config: ${errorMessage(error)}. Using empty config.`),
					identity,
				),
			],
		};
	}

	try {
		const { config, issues } = parseProvidersConfigTolerant(raw);
		return {
			source: { ...identity, config },
			issues: issues.map((issue) =>
				sourceConfigIssue({ ...issue, message: `Validation errors: ${issue.message}` }, identity),
			),
		};
	} catch (error) {
		return {
			source: { ...identity, config: {} },
			issues: [
				sourceConfigIssue(
					warning(
						[],
						error instanceof SyntaxError
							? `Failed to parse as JSONC: ${errorMessage(error)}. Using empty config.`
							: `Failed to load config: ${errorMessage(error)}. Using empty config.`,
					),
					identity,
				),
			],
		};
	}
}

/** Read an admin fragment strictly and all-or-nothing. */
export function readEnvFragment(
	kind: "enforced" | "default",
	envVarName: string,
	env: Record<string, string | undefined>,
): ProviderConfigSourceReadReport {
	const identity = { kind, label: envVarName };
	const envValue = env[envVarName];
	if (!envValue) {
		return { issues: [] };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(envValue);
	} catch (error) {
		return {
			issues: [
				sourcedWarning(
					identity,
					[],
					`Failed to parse ${envVarName} as JSON: ${errorMessage(error)}. Ignoring.`,
				),
			],
		};
	}

	const result = providersConfigFragmentSchema.safeParse(parsed);
	if (!result.success) {
		return {
			issues: [
				sourcedWarning(
					identity,
					configIssuePath(result.error.issues[0]?.path ?? []),
					`Validation errors in ${envVarName}: ${formatZodErrors(result.error)}. Ignoring.`,
				),
			],
		};
	}

	return { source: { ...identity, config: result.data }, issues: [] };
}

function sourcedWarning(
	identity: Pick<ProviderConfigSource, "kind" | "label">,
	path: readonly (string | number)[],
	message: string,
): SourcedConfigIssue {
	return sourceConfigIssue(warning(path, message), identity);
}

function warning(path: readonly (string | number)[], message: string): ConfigIssue {
	return { severity: "warning", path, message };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isErrnoCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function formatZodErrors(error: {
	issues: readonly { message: string; path?: readonly PropertyKey[] }[];
}): string {
	return error.issues.map((issue) => `${issue.path?.join(".") ?? ""}: ${issue.message}`).join("; ");
}
