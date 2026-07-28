/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * PROVIDER-SETTINGS-MIGRATION(legacy-positron): delete this module with the
 * legacy settings channels. Grep PROVIDER-SETTINGS-MIGRATION for the gates
 * that go with it (translator, source builders, loader option, kind union +
 * RANK entries, tests, docs, consumer readers).
 *
 * The complete legacy Positron settings → providers.json map — the single
 * source of truth consumed by both the runtime `legacy-positron` /
 * `legacy-positron-enforced` catalog layers and Positron's one-shot settings
 * migration.
 *
 * The connection rows are the union of Positron's migration table and the
 * runtime derivation from the bridge's `PROVIDER_MAP` + `CONFIG_KEY_OVERRIDES`
 * (every `apikey` provider except the snowflake/databricks special cases). A
 * runtime guard in ai-provider-bridge's tests pins the rows against that
 * derivation, so the legacy section names can never drift from the bridge.
 */

import type { BuiltinProviderId } from "../vocabulary.js";

// ---------------------------------------------------------------------------
// Connection rows
// ---------------------------------------------------------------------------

/** `authentication.<configKey>.{baseUrl,customHeaders}` → `providers.<providerId>`. */
export interface LegacyConnectionRow {
	/** VS Code `authentication.<configKey>.*` section, e.g. "openai-api". */
	readonly configKey: string;
	/** Catalog provider id the section maps to. */
	readonly providerId: BuiltinProviderId;
}

/**
 * Every provider whose connection lives under `authentication.<configKey>`.
 * `googleVertex` is the one row not derivable from the bridge (its
 * `PROVIDER_MAP` credentialType is `google-cloud`, not `apikey`); snowflake
 * and databricks store their hosts under `.credentials` instead and are
 * handled by the credential-section reads.
 */
export const LEGACY_CONNECTION_ROWS = [
	{ configKey: "anthropic", providerId: "anthropic" },
	{ configKey: "openai-api", providerId: "openai" },
	{ configKey: "google", providerId: "gemini" },
	{ configKey: "deepseek-api", providerId: "deepseek" },
	{ configKey: "foundry", providerId: "ms-foundry" },
	{ configKey: "openai-compatible", providerId: "openai-compatible" },
	{ configKey: "github", providerId: "copilot" },
	{ configKey: "googleVertex", providerId: "google-vertex" },
] as const satisfies readonly LegacyConnectionRow[];

// ---------------------------------------------------------------------------
// Credential-section keys
// ---------------------------------------------------------------------------

export const GOOGLE_VERTEX_CREDENTIALS_KEY = "authentication.googleVertex.credentials";
export const AWS_CREDENTIALS_KEY = "authentication.aws.credentials";
export const SNOWFLAKE_CREDENTIALS_KEY = "authentication.snowflake.credentials";
export const SNOWFLAKE_CUSTOM_HEADERS_KEY = "authentication.snowflake.customHeaders";
export const DATABRICKS_CREDENTIALS_KEY = "authentication.databricks.credentials";
export const DATABRICKS_CUSTOM_HEADERS_KEY = "authentication.databricks.customHeaders";

// ---------------------------------------------------------------------------
// Enablement rows
// ---------------------------------------------------------------------------

/** Legacy enablement toggle(s) → `providers.<providerId>.enabled`. */
export interface LegacyEnablementRow {
	readonly providerId: BuiltinProviderId;
	/** `positron.assistant.provider.<name>.enable` (older generation). */
	readonly oldKey?: string;
	/** `assistant.provider.<name>.enabled` (newer generation; wins when both set). */
	readonly newKey?: string;
}

export const LEGACY_ENABLEMENT_ROWS: readonly LegacyEnablementRow[] = [
	{ providerId: "anthropic", oldKey: "positron.assistant.provider.anthropic.enable" },
	{ providerId: "openai", oldKey: "positron.assistant.provider.openAI.enable" },
	{ providerId: "gemini", oldKey: "positron.assistant.provider.google.enable" },
	{ providerId: "bedrock", oldKey: "positron.assistant.provider.amazonBedrock.enable" },
	{ providerId: "snowflake-cortex", oldKey: "positron.assistant.provider.snowflakeCortex.enable" },
	{ providerId: "ms-foundry", oldKey: "positron.assistant.provider.msFoundry.enable" },
	{ providerId: "openai-compatible", oldKey: "positron.assistant.provider.customProvider.enable" },
	{ providerId: "positai", oldKey: "positron.assistant.provider.positAI.enable" },
	{ providerId: "copilot", oldKey: "positron.assistant.provider.githubCopilot.enable" },
	{ providerId: "google-vertex", newKey: "assistant.provider.googleVertex.enabled" },
	{ providerId: "deepseek", newKey: "assistant.provider.deepseek.enabled" },
];

// ---------------------------------------------------------------------------
// Model-override rows
// ---------------------------------------------------------------------------

/**
 * `positron.assistant.models.overrides.<settingName>` →
 * `providers.<providerId>.models = { discovery: "off", custom: [...] }`.
 */
export interface LegacyModelOverrideRow {
	readonly settingName: string;
	readonly providerId: BuiltinProviderId;
}

export const MODEL_OVERRIDES_KEY_PREFIX = "positron.assistant.models.overrides.";

export const LEGACY_MODEL_OVERRIDE_ROWS: readonly LegacyModelOverrideRow[] = [
	{ settingName: "anthropic", providerId: "anthropic" },
	{ settingName: "amazonBedrock", providerId: "bedrock" },
	{ settingName: "snowflakeCortex", providerId: "snowflake-cortex" },
	{ settingName: "msFoundry", providerId: "ms-foundry" },
	{ settingName: "openAI", providerId: "openai" },
	{ settingName: "customProvider", providerId: "openai-compatible" },
	{ settingName: "positAI", providerId: "positai" },
	{ settingName: "google", providerId: "gemini" },
];

// ---------------------------------------------------------------------------
// Key inventory
// ---------------------------------------------------------------------------

/**
 * Every legacy setting key the map consumes. Positron's migration uses this
 * to decide whether there is anything to migrate.
 */
export function legacySettingKeys(): readonly string[] {
	return [
		...LEGACY_CONNECTION_ROWS.flatMap((row) => [
			`authentication.${row.configKey}.baseUrl`,
			`authentication.${row.configKey}.customHeaders`,
		]),
		GOOGLE_VERTEX_CREDENTIALS_KEY,
		AWS_CREDENTIALS_KEY,
		SNOWFLAKE_CREDENTIALS_KEY,
		SNOWFLAKE_CUSTOM_HEADERS_KEY,
		DATABRICKS_CREDENTIALS_KEY,
		DATABRICKS_CUSTOM_HEADERS_KEY,
		...LEGACY_ENABLEMENT_ROWS.flatMap((row) => [row.oldKey, row.newKey]).filter(
			(key): key is string => key !== undefined,
		),
		...LEGACY_MODEL_OVERRIDE_ROWS.map((row) => `${MODEL_OVERRIDES_KEY_PREFIX}${row.settingName}`),
	];
}
