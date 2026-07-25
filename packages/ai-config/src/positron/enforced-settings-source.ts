/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * PROVIDER-SETTINGS-MIGRATION(host-enforced): delete this module when admins have
 * migrated off POSITRON_ENFORCED_SETTINGS to POSIT_AI_PROVIDERS_ENFORCED.
 * Grep PROVIDER-SETTINGS-MIGRATION for the gates that go with it (kind union + RANK,
 * root-entry exports, tests, docs, consumer additionalSources call sites).
 *
 * Legacy `POSITRON_ENFORCED_SETTINGS` → `host-enforced` source.
 *
 * Workbench admins who still enforce provider settings through the legacy env
 * var would lose enforcement when provider config reads move off Positron's
 * config service (where that var is applied) onto the ai-config catalog. This
 * module translates the provider-relevant slice of the var into a
 * `host-enforced` source — above `user`, below the canonical `enforced` —
 * until admins migrate to `POSIT_AI_PROVIDERS_ENFORCED`.
 *
 * Keep the resolver core free of `kind === "host-enforced"` branches so the
 * removal stays a delete.
 *
 * The env var is one JSON object of flat dotted setting keys with arbitrary
 * JSON values; Positron ignores the whole var on a parse failure. We mirror
 * that envelope, then validate per key: a wrong-shaped value drops that key
 * with a warning, never the whole source.
 */

import { z } from "zod";

import type { ProviderConfigSourceProvider } from "../config-source.js";
import type { ProviderConfigSource } from "../resolve-catalog.js";
import type { LoggerLike } from "../types.js";
import {
	buildAuthenticationFragment,
	type PositronAuthSettingDescriptor,
	type PositronAuthSettingReader,
} from "./authentication-fragment.js";

/** The legacy Workbench admin-enforcement env var. */
export const POSITRON_ENFORCED_SETTINGS_ENV_VAR = "POSITRON_ENFORCED_SETTINGS";

const stringValueSchema = z.string();
const headersValueSchema = z.record(z.string(), z.string());
const credentialsSectionSchema = z.record(z.string(), z.unknown());

/**
 * A `PositronAuthSettingReader` over the parsed flat dotted-key map, so
 * `buildAuthenticationFragment` translates the enforced payload with the same
 * omit-empty semantics as the `host` source. Reads are payload-only — no
 * `process.env` fallbacks, so an ambient env var can never be promoted to
 * enforced rank.
 *
 * `warnedKeys` is owned by the source (which re-reads on every catalog
 * rebuild), so each dropped key warns once per process, not per rebuild — and
 * the snowflake reads, which hit the same credentials section three times,
 * warn once.
 */
function createEnforcedSettingsReader(
	settings: Readonly<Record<string, unknown>>,
	warnedKeys: Set<string>,
	logger?: LoggerLike,
): PositronAuthSettingReader {
	const warnDropped = (key: string, expected: string) => {
		if (warnedKeys.has(key)) {
			return;
		}
		warnedKeys.add(key);
		logger?.warn(
			`[ai-config] ${POSITRON_ENFORCED_SETTINGS_ENV_VAR}: ignoring "${key}" — expected ${expected}.`,
		);
	};

	const readString = (key: string): string | undefined => {
		const value = settings[key];
		if (value === undefined) {
			return undefined;
		}
		const result = stringValueSchema.safeParse(value);
		if (!result.success) {
			warnDropped(key, "a string");
			return undefined;
		}
		return result.data;
	};

	const readHeaders = (key: string): Record<string, string> | undefined => {
		const value = settings[key];
		if (value === undefined) {
			return undefined;
		}
		const result = headersValueSchema.safeParse(value);
		if (!result.success) {
			warnDropped(key, "an object of string header values");
			return undefined;
		}
		return result.data;
	};

	const readCredentialField = (sectionKey: string, field: string): string | undefined => {
		const section = settings[sectionKey];
		if (section === undefined) {
			return undefined;
		}
		const sectionResult = credentialsSectionSchema.safeParse(section);
		if (!sectionResult.success) {
			warnDropped(sectionKey, "a credentials object");
			return undefined;
		}
		const value = sectionResult.data[field];
		if (value === undefined) {
			return undefined;
		}
		const result = stringValueSchema.safeParse(value);
		if (!result.success) {
			warnDropped(`${sectionKey}.${field}`, "a string");
			return undefined;
		}
		return result.data;
	};

	return {
		getBaseUrl: (configKey) => readString(`authentication.${configKey}.baseUrl`),
		getCustomHeaders: (configKey) => readHeaders(`authentication.${configKey}.customHeaders`),
		getAwsRegion: () => readCredentialField("authentication.aws.credentials", "AWS_REGION"),
		getSnowflake: () => ({
			host: readCredentialField("authentication.snowflake.credentials", "SNOWFLAKE_HOST"),
			account: readCredentialField("authentication.snowflake.credentials", "SNOWFLAKE_ACCOUNT"),
			home: readCredentialField("authentication.snowflake.credentials", "SNOWFLAKE_HOME"),
		}),
		getDatabricks: () => ({
			host: readCredentialField("authentication.databricks.credentials", "DATABRICKS_HOST"),
		}),
	};
}

/**
 * Build the `host-enforced` source from `POSITRON_ENFORCED_SETTINGS`.
 *
 * Unset → no source; malformed JSON or non-object → warn and skip; a payload
 * with no provider-relevant keys is inert. Static — no `watch()`.
 *
 * @param descriptors - The same consumer-derived mapping the `host` source
 *   uses; `normalizeBaseUrl` hooks apply here too.
 * @param env - Explicit env map (callers pass `process.env`); this module
 *   never reads Node globals.
 */
export function createPositronEnforcedConfigSource(
	descriptors: readonly PositronAuthSettingDescriptor[],
	env: Readonly<Record<string, string | undefined>>,
	logger?: LoggerLike,
): ProviderConfigSourceProvider {
	// The watch seam re-reads sources on every rebuild; warn once per process.
	const warnedKeys = new Set<string>();

	return {
		read(): ProviderConfigSource | undefined {
			const raw = env[POSITRON_ENFORCED_SETTINGS_ENV_VAR];
			if (!raw) {
				return undefined;
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				// No error detail: JSON.parse messages embed input snippets, and
				// this payload can carry credential-adjacent values.
				logger?.warn(
					`[ai-config] Failed to parse ${POSITRON_ENFORCED_SETTINGS_ENV_VAR} as JSON. Ignoring.`,
				);
				return undefined;
			}
			if (!isPlainObject(parsed)) {
				logger?.warn(
					`[ai-config] ${POSITRON_ENFORCED_SETTINGS_ENV_VAR} is not a JSON object. Ignoring.`,
				);
				return undefined;
			}

			const reader = createEnforcedSettingsReader(parsed, warnedKeys, logger);
			const config = buildAuthenticationFragment(reader, descriptors);
			if (!config.providers || Object.keys(config.providers).length === 0) {
				return undefined;
			}

			return { kind: "host-enforced", label: POSITRON_ENFORCED_SETTINGS_ENV_VAR, config };
		},
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
