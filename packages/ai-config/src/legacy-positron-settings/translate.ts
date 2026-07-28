/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * PROVIDER-SETTINGS-MIGRATION(legacy-positron): delete this module with the
 * legacy settings channels.
 *
 * The pure legacy-settings translator: reads every key in the map through an
 * injected reader and produces a providers.json-shaped fragment plus a
 * migration record for each value written. Shared by the runtime
 * `legacy-positron` / `legacy-positron-enforced` catalog layers and Positron's
 * one-shot settings migration, so the two can never diverge.
 *
 * Per-key shape validation with warn-once drop: a wrong-shaped value drops
 * that key only, never the whole translation. Empty strings and empty header
 * maps are omitted, so a fragment can only contribute values it actually has.
 */

import * as z from "zod/v4";

import { normalizeBaseUrlForProvider } from "../base-url.js";
import type { Disposable } from "../config-source.js";
import { inferModelCapabilities } from "../model-capabilities/infer.js";
import type {
	BuiltinProviderBlock,
	CustomModel,
	EnforcedProvidersConfig,
	LoggerLike,
} from "../types.js";
import type { BuiltinProviderId } from "../vocabulary.js";
import {
	AWS_CREDENTIALS_KEY,
	DATABRICKS_CREDENTIALS_KEY,
	DATABRICKS_CUSTOM_HEADERS_KEY,
	GOOGLE_VERTEX_CREDENTIALS_KEY,
	LEGACY_CONNECTION_ROWS,
	LEGACY_ENABLEMENT_ROWS,
	LEGACY_MODEL_OVERRIDE_ROWS,
	MODEL_OVERRIDES_KEY_PREFIX,
	SNOWFLAKE_CREDENTIALS_KEY,
	SNOWFLAKE_CUSTOM_HEADERS_KEY,
} from "./map.js";

// ---------------------------------------------------------------------------
// Public contracts
// ---------------------------------------------------------------------------

/** The one injected seam: how to read a legacy Positron setting in this environment. */
export interface LegacySettingsReader {
	/**
	 * Raw **user-set** value for a legacy key (e.g.
	 * "authentication.anthropic.baseUrl") — never the effective value, so
	 * enforced/default settings cannot leak into the non-enforced layer.
	 */
	get(key: string): unknown;
	/** Fire onChange when any legacy setting may have changed. */
	watch(onChange: () => void): Disposable;
}

/** One legacy setting mapped to the dotted providers.json path it wrote. */
export interface SettingMigration {
	/** Source legacy setting key. */
	readonly source: string;
	/** Destination providers.json dotted path (e.g. providers.openai.baseUrl). */
	readonly destination: string;
	/**
	 * Log-safe rendering of the written value. Header values are reduced to
	 * their names since they can carry auth tokens; all other values are safe
	 * to show verbatim.
	 */
	readonly value: string;
}

/** Result of {@link translateLegacyPositronSettings}. */
export interface TranslatedLegacySettings {
	/** The providers.json-shaped fragment (empty when nothing is set). */
	readonly config: EnforcedProvidersConfig;
	/** One record per value written, for the migration's logging. */
	readonly migrations: readonly SettingMigration[];
}

// ---------------------------------------------------------------------------
// Per-key value schemas
// ---------------------------------------------------------------------------

const headersValueSchema = z.record(z.string(), z.string());
const credentialsSectionSchema = z.record(z.string(), z.unknown());

/**
 * One legacy `positron.assistant.models.overrides.*` entry. Loose so extra
 * legacy fields never invalidate an entry; token limits must be positive
 * integers or the entry is filtered (the strict custom-model schema would
 * otherwise reject the whole merged layer downstream).
 */
const legacyModelOverrideSchema = z.looseObject({
	name: z.string().min(1),
	identifier: z.string().min(1),
	maxInputTokens: z.int().positive().optional(),
	maxOutputTokens: z.int().positive().optional(),
});

type LegacyModelOverride = z.infer<typeof legacyModelOverrideSchema>;

// ---------------------------------------------------------------------------
// Translator
// ---------------------------------------------------------------------------

/**
 * Translate the legacy Positron settings visible through `reader` into a
 * providers.json-shaped fragment plus migration records.
 *
 * @param reader - Key-value access to the legacy settings (user-set values).
 * @param logger - Per-key drop warnings.
 * @param warnedKeys - Caller-owned warn-once state: a dropped key warns once
 *   per set, so watch-seam rebuilds that re-translate do not repeat warnings.
 */
export function translateLegacyPositronSettings(
	reader: Pick<LegacySettingsReader, "get">,
	logger?: LoggerLike,
	warnedKeys: Set<string> = new Set(),
): TranslatedLegacySettings {
	const providers: Record<string, BuiltinProviderBlock> = {};
	const migrations: SettingMigration[] = [];

	const merge = (providerId: BuiltinProviderId, fragment: BuiltinProviderBlock) => {
		providers[providerId] = { ...providers[providerId], ...fragment };
	};
	const record = (source: string, destination: string, value: string) => {
		migrations.push({ source, destination, value });
	};

	const warnDropped = (key: string, expected: string) => {
		if (warnedKeys.has(key)) {
			return;
		}
		warnedKeys.add(key);
		logger?.warn(`[ai-config] Ignoring legacy Positron setting "${key}" — expected ${expected}.`);
	};

	const readString = (key: string): string | undefined => {
		const value = reader.get(key);
		if (value === undefined) {
			return undefined;
		}
		if (typeof value !== "string") {
			warnDropped(key, "a string");
			return undefined;
		}
		return value.trim() !== "" ? value : undefined;
	};

	const readHeaders = (key: string): Record<string, string> | undefined => {
		const value = reader.get(key);
		if (value === undefined) {
			return undefined;
		}
		const result = headersValueSchema.safeParse(value);
		if (!result.success) {
			warnDropped(key, "an object of string header values");
			return undefined;
		}
		return Object.keys(result.data).length > 0 ? result.data : undefined;
	};

	const readCredentialField = (sectionKey: string, field: string): string | undefined => {
		const section = reader.get(sectionKey);
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
		if (typeof value !== "string") {
			warnDropped(`${sectionKey}.${field}`, "a string");
			return undefined;
		}
		return value.trim() !== "" ? value : undefined;
	};

	const readBoolean = (key: string): boolean | undefined => {
		const value = reader.get(key);
		if (value === undefined) {
			return undefined;
		}
		if (typeof value !== "boolean") {
			warnDropped(key, "a boolean");
			return undefined;
		}
		return value;
	};

	// --- authentication.<configKey>.{baseUrl,customHeaders} -----------------
	for (const row of LEGACY_CONNECTION_ROWS) {
		const baseUrlKey = `authentication.${row.configKey}.baseUrl`;
		const rawBaseUrl = readString(baseUrlKey);
		if (rawBaseUrl) {
			// Bare known hosts are corrected here so both the runtime layers and
			// the migration write the versioned form.
			const baseUrl = normalizeBaseUrlForProvider(row.providerId, rawBaseUrl);
			merge(row.providerId, { baseUrl });
			record(baseUrlKey, `providers.${row.providerId}.baseUrl`, JSON.stringify(baseUrl));
		}
		const headersKey = `authentication.${row.configKey}.customHeaders`;
		const headers = readHeaders(headersKey);
		if (headers) {
			merge(row.providerId, { customHeaders: headers });
			record(headersKey, `providers.${row.providerId}.customHeaders`, headerNames(headers));
		}
	}

	// --- authentication.googleVertex.credentials → googleCloud --------------
	const googleCloud: { project?: string; location?: string } = {};
	const project = readCredentialField(GOOGLE_VERTEX_CREDENTIALS_KEY, "GOOGLE_VERTEX_PROJECT");
	if (project) {
		googleCloud.project = project;
		record(
			GOOGLE_VERTEX_CREDENTIALS_KEY,
			"providers.google-vertex.googleCloud.project",
			JSON.stringify(project),
		);
	}
	const location = readCredentialField(GOOGLE_VERTEX_CREDENTIALS_KEY, "GOOGLE_VERTEX_LOCATION");
	if (location) {
		googleCloud.location = location;
		record(
			GOOGLE_VERTEX_CREDENTIALS_KEY,
			"providers.google-vertex.googleCloud.location",
			JSON.stringify(location),
		);
	}
	if (hasKeys(googleCloud)) {
		merge("google-vertex", { googleCloud });
	}

	// --- authentication.aws.credentials → bedrock.aws ------------------------
	const aws: { profile?: string; region?: string } = {};
	const profile = readCredentialField(AWS_CREDENTIALS_KEY, "AWS_PROFILE");
	if (profile) {
		aws.profile = profile;
		record(AWS_CREDENTIALS_KEY, "providers.bedrock.aws.profile", JSON.stringify(profile));
	}
	const region = readCredentialField(AWS_CREDENTIALS_KEY, "AWS_REGION");
	if (region) {
		aws.region = region;
		record(AWS_CREDENTIALS_KEY, "providers.bedrock.aws.region", JSON.stringify(region));
	}
	if (hasKeys(aws)) {
		merge("bedrock", { aws });
	}

	// --- authentication.snowflake.* → snowflake-cortex -----------------------
	const snowflake: { account?: string; home?: string; host?: string } = {};
	const account = readCredentialField(SNOWFLAKE_CREDENTIALS_KEY, "SNOWFLAKE_ACCOUNT");
	if (account) {
		snowflake.account = account;
		record(
			SNOWFLAKE_CREDENTIALS_KEY,
			"providers.snowflake-cortex.snowflake.account",
			JSON.stringify(account),
		);
	}
	const home = readCredentialField(SNOWFLAKE_CREDENTIALS_KEY, "SNOWFLAKE_HOME");
	if (home) {
		snowflake.home = home;
		record(
			SNOWFLAKE_CREDENTIALS_KEY,
			"providers.snowflake-cortex.snowflake.home",
			JSON.stringify(home),
		);
	}
	const snowflakeHost = readCredentialField(SNOWFLAKE_CREDENTIALS_KEY, "SNOWFLAKE_HOST");
	if (snowflakeHost) {
		snowflake.host = snowflakeHost;
		record(
			SNOWFLAKE_CREDENTIALS_KEY,
			"providers.snowflake-cortex.snowflake.host",
			JSON.stringify(snowflakeHost),
		);
	}
	if (hasKeys(snowflake)) {
		merge("snowflake-cortex", { snowflake });
	}
	const snowflakeHeaders = readHeaders(SNOWFLAKE_CUSTOM_HEADERS_KEY);
	if (snowflakeHeaders) {
		merge("snowflake-cortex", { customHeaders: snowflakeHeaders });
		record(
			SNOWFLAKE_CUSTOM_HEADERS_KEY,
			"providers.snowflake-cortex.customHeaders",
			headerNames(snowflakeHeaders),
		);
	}

	// --- authentication.databricks.* → databricks ----------------------------
	// The workspace host lands in the `databricks` connection section, NOT
	// `baseUrl` — a bare workspace host in baseUrl would be picked up by
	// per-model endpoint resolution and route chat to it.
	const databricksHost = readCredentialField(DATABRICKS_CREDENTIALS_KEY, "DATABRICKS_HOST");
	if (databricksHost) {
		merge("databricks", { databricks: { host: databricksHost } });
		record(
			DATABRICKS_CREDENTIALS_KEY,
			"providers.databricks.databricks.host",
			JSON.stringify(databricksHost),
		);
	}
	const databricksHeaders = readHeaders(DATABRICKS_CUSTOM_HEADERS_KEY);
	if (databricksHeaders) {
		merge("databricks", { customHeaders: databricksHeaders });
		record(
			DATABRICKS_CUSTOM_HEADERS_KEY,
			"providers.databricks.customHeaders",
			headerNames(databricksHeaders),
		);
	}

	// --- enablement toggles → providers.<id>.enabled -------------------------
	for (const row of LEGACY_ENABLEMENT_ROWS) {
		const newValue = row.newKey !== undefined ? readBoolean(row.newKey) : undefined;
		const oldValue = row.oldKey !== undefined ? readBoolean(row.oldKey) : undefined;
		const winner =
			row.newKey !== undefined && newValue !== undefined
				? { key: row.newKey, enabled: newValue }
				: row.oldKey !== undefined && oldValue !== undefined
					? { key: row.oldKey, enabled: oldValue }
					: undefined;
		if (winner) {
			merge(row.providerId, { enabled: winner.enabled });
			record(winner.key, `providers.${row.providerId}.enabled`, String(winner.enabled));
		}
	}

	// --- model overrides → models.custom + discovery off ---------------------
	for (const row of LEGACY_MODEL_OVERRIDE_ROWS) {
		const key = `${MODEL_OVERRIDES_KEY_PREFIX}${row.settingName}`;
		const raw = reader.get(key);
		if (raw === undefined) {
			continue;
		}
		if (!Array.isArray(raw)) {
			warnDropped(key, "an array of model overrides");
			continue;
		}
		const entries = raw
			.map((entry) => legacyModelOverrideSchema.safeParse(entry))
			.filter((result) => result.success)
			.map((result) => result.data);
		if (entries.length === 0) {
			continue;
		}
		const custom = entries.map((entry) => buildCustomModel(row.providerId, entry));
		merge(row.providerId, { models: { discovery: "off", custom } });
		const modelIds = entries.map((entry) => entry.identifier).join(", ");
		record(key, `providers.${row.providerId}.models.custom`, `[${modelIds}]`);
	}

	if (Object.keys(providers).length === 0) {
		return { config: {}, migrations };
	}

	// The strict EnforcedProvidersMap type has no index signature (its keys are
	// the fixed built-in ids plus `default`/`custom`), so a dynamically-keyed
	// accumulator can't be expressed as that type directly — hence the single
	// cast. The map only ever emits built-in provider ids, so the record is a
	// valid partial built-in map.
	return {
		config: { providers: providers as EnforcedProvidersConfig["providers"] },
		migrations,
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Legacy entries carry only name/identifier/token limits; capabilities are
 * synthesized with ai-config's own inference, user token limits win, and
 * maxContextLength never drops below the user's maxInputTokens.
 */
function buildCustomModel(providerId: BuiltinProviderId, entry: LegacyModelOverride): CustomModel {
	const caps = inferModelCapabilities(providerId, entry.identifier);
	const model: CustomModel = {
		id: entry.identifier,
		name: entry.name,
		maxContextLength: Math.max(caps.maxContextLength, entry.maxInputTokens ?? 0),
		supportsTools: caps.supportsTools,
		supportsImages: caps.supportsImages,
		supportsToolResultImages: caps.supportsToolResultImages,
		supportsWebSearch: caps.supportsWebSearch,
	};
	const maxInputTokens = entry.maxInputTokens ?? caps.maxInputTokens;
	if (maxInputTokens !== undefined) {
		model.maxInputTokens = maxInputTokens;
	}
	const maxOutputTokens = entry.maxOutputTokens ?? caps.maxOutputTokens;
	if (maxOutputTokens !== undefined) {
		model.maxOutputTokens = maxOutputTokens;
	}
	if (caps.thinkingEffortLevels !== undefined) {
		model.thinkingEffortLevels = caps.thinkingEffortLevels;
	}
	if (caps.protocol !== undefined) {
		model.protocol = caps.protocol;
	}
	return model;
}

/** Header names only; values can carry auth tokens and must not be logged. */
function headerNames(headers: Record<string, string>): string {
	return `[${Object.keys(headers).join(", ")}]`;
}

function hasKeys(obj: object): boolean {
	return Object.keys(obj).length > 0;
}
