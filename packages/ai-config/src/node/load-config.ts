/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/** Read providers.json and env fragments into structured source reports. */

import { promises as fs } from "fs";

import { formatConfigIssue, sourceConfigIssue, sourcedWholeSourceIssue } from "../config-issue.js";
import type { ProviderConfigSourceReadReport } from "../config-source.js";
import type { ProviderConfigSource } from "../resolve-catalog.js";
import { salvageProvidersConfigFragment } from "../salvage-config.js";
import type { SalvageFailureReason } from "../salvage-config.js";
import type { LoggerLike } from "../types.js";
import { parseProvidersConfigTolerant } from "./parse-providers-config.js";
import { DEFAULT_ENV_VAR, ENFORCED_ENV_VAR, PROVIDERS_CONFIG_PATH } from "./paths.js";

export interface LoadConfigSourcesOptions {
	readonly configPath?: string;
	readonly enforcedEnvVar?: string;
	readonly defaultEnvVar?: string;
	/**
	 * Required environment for enforced/default fragments. Hosts that delete
	 * these variables from `process.env` must retain their values here.
	 */
	readonly env: Record<string, string | undefined>;
	readonly logger?: LoggerLike;
}

/** Assemble complete read reports without rendering diagnostics. */
export async function loadConfigSourceReports(
	opts: LoadConfigSourcesOptions,
): Promise<ProviderConfigSourceReadReport[]> {
	const configPath = opts.configPath ?? PROVIDERS_CONFIG_PATH;
	const enforcedEnvVar = opts.enforcedEnvVar ?? ENFORCED_ENV_VAR;
	const defaultEnvVar = opts.defaultEnvVar ?? DEFAULT_ENV_VAR;
	const env = opts.env;

	return [
		await readFileConfig(configPath),
		readEnvFragment("enforced", enforcedEnvVar, env),
		readEnvFragment("default", defaultEnvVar, env),
	];
}

/** Compatibility wrapper retaining the historical bare-source signature. */
export async function loadConfigSources(
	opts: LoadConfigSourcesOptions,
): Promise<ProviderConfigSource[]> {
	const reports = await loadConfigSourceReports(opts);
	for (const issue of reports.flatMap((report) => report.issues)) {
		opts.logger?.warn(formatConfigIssue(issue));
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
				sourcedWholeSourceIssue(
					identity,
					`Could not read the file: ${errorMessage(error)}. Using empty config.`,
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
				sourcedWholeSourceIssue(
					identity,
					error instanceof SyntaxError
						? `Invalid JSONC: ${errorMessage(error)}. Using empty config.`
						: `Unexpected error: ${errorMessage(error)}. Using empty config.`,
				),
			],
		};
	}
}

/**
 * Read an admin fragment tolerantly. Unrecognized keys are removed and a
 * provider block with an invalid value is dropped, each as a warning with a
 * path, so the payload's remaining rules still apply. Only an unusable payload
 * (bad JSON, non-object root or `providers`, unsupported version) is ignored
 * whole, as an error naming the env var.
 */
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
				sourcedWholeSourceIssue(
					identity,
					`Failed to parse ${envVarName} as JSON: ${errorMessage(error)}. Ignoring.`,
				),
			],
		};
	}

	const result = salvageProvidersConfigFragment(parsed);
	if (!result.ok) {
		return {
			issues: [sourcedWholeSourceIssue(identity, envFailureMessage(envVarName, result.reason))],
		};
	}

	return {
		source: { ...identity, config: result.config },
		issues: result.issues.map((issue) => sourceConfigIssue(issue, identity)),
	};
}

function envFailureMessage(envVarName: string, reason: SalvageFailureReason): string {
	switch (reason.kind) {
		case "not-object":
			return `${envVarName} must contain a JSON object. Ignoring.`;
		case "unsupported-version":
			return `Unsupported ${envVarName} version; expected 1. Ignoring.`;
		case "providers-not-object":
			return `"providers" in ${envVarName} must be an object of provider blocks. Ignoring.`;
		case "seal-failed": {
			const at = reason.path.length > 0 ? ` at ${reason.path.join(".")}` : "";
			return `Internal validation of ${envVarName} failed${at}: ${reason.message}. Ignoring.`;
		}
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isErrnoCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
