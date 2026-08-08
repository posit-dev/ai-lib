/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// PROVIDER-SETTINGS-MIGRATION(legacy-positron) gate: delete this file with the module.

import { describe, expect, it, vi } from "vitest";

import { legacySettingKeys } from "../legacy-positron-settings/map.js";
import {
	createLegacyPositronSourceProviders,
	POSITRON_ENFORCED_SETTINGS_ENV_VAR,
} from "../legacy-positron-settings/sources.js";
import { translateLegacyPositronSettings } from "../legacy-positron-settings/translate.js";
import type { LegacySettingsReader } from "../legacy-positron-settings/translate.js";
import { inferModelCapabilities } from "../model-capabilities/infer.js";
import { providersConfigSchema } from "../schema.js";

function makeLogger() {
	return { debug: vi.fn(), warn: vi.fn() };
}

function readerOf(values: Record<string, unknown>): Pick<LegacySettingsReader, "get"> {
	return { get: (key) => values[key] };
}

function translate(values: Record<string, unknown>) {
	const logger = makeLogger();
	const result = translateLegacyPositronSettings(readerOf(values), logger);
	return { ...result, logger };
}

// ===========================================================================
// Translator — connection rows
// ===========================================================================

describe("translateLegacyPositronSettings — connection rows", () => {
	it("maps connection settings to provider blocks", () => {
		const { config } = translate({
			"authentication.anthropic.baseUrl": "https://gateway.example.com",
			"authentication.anthropic.customHeaders": { "x-team": "data-science" },
			"authentication.openai-api.baseUrl": "https://openai.example.com",
		});
		expect(config.providers?.anthropic).toEqual({
			baseUrl: "https://gateway.example.com",
			customHeaders: { "x-team": "data-science" },
		});
		expect(config.providers?.openai).toEqual({ baseUrl: "https://openai.example.com" });
	});

	it("covers the legacy section names, including the runtime-only github row", () => {
		const { config } = translate({
			"authentication.google.baseUrl": "https://gemini.example.com",
			"authentication.deepseek-api.baseUrl": "https://deepseek.example.com",
			"authentication.foundry.baseUrl": "https://foundry.example.com",
			"authentication.openai-compatible.baseUrl": "https://compat.example.com",
			"authentication.github.baseUrl": "https://copilot.example.com",
			"authentication.googleVertex.baseUrl": "https://vertex.example.com",
		});
		expect(config.providers?.gemini?.baseUrl).toBe("https://gemini.example.com");
		expect(config.providers?.deepseek?.baseUrl).toBe("https://deepseek.example.com");
		expect(config.providers?.["ms-foundry"]?.baseUrl).toBe("https://foundry.example.com");
		expect(config.providers?.["openai-compatible"]?.baseUrl).toBe("https://compat.example.com");
		expect(config.providers?.copilot?.baseUrl).toBe("https://copilot.example.com");
		expect(config.providers?.["google-vertex"]?.baseUrl).toBe("https://vertex.example.com");
	});

	it("corrects a bare known host to its versioned form (runtime AND migration)", () => {
		const { config, migrations } = translate({
			"authentication.anthropic.baseUrl": "https://api.anthropic.com",
		});
		expect(config.providers?.anthropic?.baseUrl).toBe("https://api.anthropic.com/v1");
		// The migration record carries the corrected value that was written.
		expect(migrations).toEqual([
			{
				source: "authentication.anthropic.baseUrl",
				destination: "providers.anthropic.baseUrl",
				value: '"https://api.anthropic.com/v1"',
			},
		]);
	});

	it("copies a foundry base URL verbatim (no bare-host policy)", () => {
		const { config } = translate({
			"authentication.foundry.baseUrl": "https://my-resource.services.ai.azure.com",
		});
		expect(config.providers?.["ms-foundry"]).toEqual({
			baseUrl: "https://my-resource.services.ai.azure.com",
		});
	});

	it("omits empty strings and empty header maps", () => {
		const { config, migrations, logger } = translate({
			"authentication.anthropic.baseUrl": "",
			"authentication.anthropic.customHeaders": {},
		});
		expect(config).toEqual({});
		expect(migrations).toEqual([]);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("drops a wrong-typed key with a warning, keeping the rest", () => {
		const { config, logger } = translate({
			"authentication.anthropic.baseUrl": 42,
			"authentication.anthropic.customHeaders": { "x-team": "ml" },
		});
		expect(config.providers?.anthropic).toEqual({ customHeaders: { "x-team": "ml" } });
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('"authentication.anthropic.baseUrl"'),
		);
	});

	it("drops non-string-map customHeaders with a warning", () => {
		const { config, logger } = translate({
			"authentication.anthropic.baseUrl": "https://proxy.example.com",
			"authentication.anthropic.customHeaders": { "x-count": 3 },
		});
		expect(config.providers?.anthropic).toEqual({ baseUrl: "https://proxy.example.com" });
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('"authentication.anthropic.customHeaders"'),
		);
	});
});

// ===========================================================================
// Translator — credential sections
// ===========================================================================

describe("translateLegacyPositronSettings — credential sections", () => {
	it("maps grouped credential settings to their sections", () => {
		const { config } = translate({
			"authentication.aws.credentials": { AWS_PROFILE: "default", AWS_REGION: "us-east-1" },
			"authentication.googleVertex.credentials": {
				GOOGLE_VERTEX_PROJECT: "my-project",
				GOOGLE_VERTEX_LOCATION: "us-central1",
			},
			"authentication.snowflake.credentials": {
				SNOWFLAKE_ACCOUNT: "MYORG-MYACCT",
				SNOWFLAKE_HOME: "/tmp/snow",
				SNOWFLAKE_HOST: "acct.snowflakecomputing.com",
			},
		});
		expect(config.providers?.bedrock).toEqual({
			aws: { profile: "default", region: "us-east-1" },
		});
		expect(config.providers?.["google-vertex"]).toEqual({
			googleCloud: { project: "my-project", location: "us-central1" },
		});
		expect(config.providers?.["snowflake-cortex"]).toEqual({
			snowflake: {
				account: "MYORG-MYACCT",
				home: "/tmp/snow",
				host: "acct.snowflakecomputing.com",
			},
		});
	});

	it("maps the databricks host into the databricks section, never baseUrl", () => {
		const { config } = translate({
			"authentication.databricks.credentials": { DATABRICKS_HOST: "dbx.example.com" },
			"authentication.databricks.customHeaders": { "x-team": "ml" },
		});
		expect(config.providers?.databricks).toEqual({
			databricks: { host: "dbx.example.com" },
			customHeaders: { "x-team": "ml" },
		});
		expect(config.providers?.databricks?.baseUrl).toBeUndefined();
	});

	it("maps snowflake customHeaders alongside the credentials section", () => {
		const { config } = translate({
			"authentication.snowflake.customHeaders": { "x-snowflake": "yes" },
		});
		expect(config.providers?.["snowflake-cortex"]).toEqual({
			customHeaders: { "x-snowflake": "yes" },
		});
	});

	it("drops a non-object credentials section with a single warning", () => {
		const { config, logger } = translate({
			"authentication.aws.credentials": "us-east-1",
			"authentication.anthropic.baseUrl": "https://proxy.example.com",
		});
		expect(config.providers?.bedrock).toBeUndefined();
		expect(config.providers?.anthropic?.baseUrl).toBe("https://proxy.example.com");
		const drops = logger.warn.mock.calls.filter(([msg]) =>
			String(msg).includes("authentication.aws.credentials"),
		);
		expect(drops).toHaveLength(1);
	});

	it("drops a wrong-typed credential field but keeps the section's other fields", () => {
		const { config, logger } = translate({
			"authentication.aws.credentials": { AWS_PROFILE: 42, AWS_REGION: "eu-west-1" },
		});
		expect(config.providers?.bedrock).toEqual({ aws: { region: "eu-west-1" } });
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('"authentication.aws.credentials.AWS_PROFILE"'),
		);
	});
});

// ===========================================================================
// Translator — enablement
// ===========================================================================

describe("translateLegacyPositronSettings — enablement", () => {
	it("maps enablement toggles to providers.<id>.enabled", () => {
		const { config } = translate({
			"positron.assistant.provider.anthropic.enable": false,
			"positron.assistant.provider.google.enable": true,
			"assistant.provider.deepseek.enabled": false,
		});
		expect(config.providers?.anthropic?.enabled).toBe(false);
		expect(config.providers?.gemini?.enabled).toBe(true);
		expect(config.providers?.deepseek?.enabled).toBe(false);
	});

	it("drops a non-boolean enablement value with a warning", () => {
		const { config, logger } = translate({
			"positron.assistant.provider.anthropic.enable": "false",
		});
		expect(config.providers?.anthropic).toBeUndefined();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('"positron.assistant.provider.anthropic.enable"'),
		);
	});

	it("records the winning source key in the migration record", () => {
		const { migrations } = translate({
			"positron.assistant.provider.githubCopilot.enable": false,
		});
		expect(migrations).toEqual([
			{
				source: "positron.assistant.provider.githubCopilot.enable",
				destination: "providers.copilot.enabled",
				value: "false",
			},
		]);
	});
});

// ===========================================================================
// Translator — model overrides
// ===========================================================================

describe("translateLegacyPositronSettings — model overrides", () => {
	it("converts model overrides to custom models with discovery off", () => {
		const { config, logger } = translate({
			"positron.assistant.models.overrides.anthropic": [
				{ name: "Sonnet (team)", identifier: "claude-sonnet-4-5", maxInputTokens: 300_000 },
				{ identifier: "missing-name" }, // malformed: skipped, warns once for the key
			],
		});
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('"positron.assistant.models.overrides.anthropic"'),
		);
		const models = config.providers?.anthropic?.models;
		expect(models?.discovery).toBe("off");
		expect(models?.custom).toHaveLength(1);
		const model = models?.custom?.[0];
		expect(model?.id).toBe("claude-sonnet-4-5");
		expect(model?.name).toBe("Sonnet (team)");
		// The user's token limit wins and floors maxContextLength.
		expect(model?.maxInputTokens).toBe(300_000);
		expect(model?.maxContextLength).toBeGreaterThanOrEqual(300_000);
		// Capabilities are synthesized from ai-config's own inference.
		const caps = inferModelCapabilities("anthropic", "claude-sonnet-4-5");
		expect(model?.supportsTools).toBe(caps.supportsTools);
		expect(model?.supportsImages).toBe(caps.supportsImages);
		expect(model?.thinkingEffortLevels).toEqual(caps.thinkingEffortLevels);
	});

	it("an overrides array with only malformed entries maps nothing and warns", () => {
		const { config, logger } = translate({
			"positron.assistant.models.overrides.openAI": [{ nope: true }],
		});
		expect(config).toEqual({});
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('"positron.assistant.models.overrides.openAI"'),
		);
	});

	it("carries inferred capabilities into the custom model", () => {
		const { config } = translate({
			"positron.assistant.models.overrides.anthropic": [
				{ name: "Sonnet", identifier: "claude-sonnet-4-5" },
			],
		});
		const model = config.providers?.anthropic?.models?.custom?.[0];
		const caps = inferModelCapabilities("anthropic", "claude-sonnet-4-5");
		expect(caps.family).toBeDefined();
		expect(caps.supportedInputMediaTypes).toBeDefined();
		expect(model).toEqual(expect.objectContaining(caps));
	});

	it("a non-array overrides value is dropped with a warning", () => {
		const { config, logger } = translate({
			"positron.assistant.models.overrides.openAI": { name: "x", identifier: "y" },
		});
		expect(config).toEqual({});
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('"positron.assistant.models.overrides.openAI"'),
		);
	});

	it("records model ids (not payloads) in the migration record", () => {
		const { migrations } = translate({
			"positron.assistant.models.overrides.positAI": [
				{ name: "A", identifier: "model-a" },
				{ name: "B", identifier: "model-b" },
			],
		});
		expect(migrations).toEqual([
			{
				source: "positron.assistant.models.overrides.positAI",
				destination: "providers.positai.models.custom",
				value: "[model-a, model-b]",
			},
		]);
	});

	it("synthesized custom models satisfy the strict custom-model schema", () => {
		const { config } = translate({
			"positron.assistant.models.overrides.anthropic": [
				{ name: "Sonnet", identifier: "claude-sonnet-4-5" },
			],
		});
		// Round-trip through the full config schema: the models block must be
		// valid as written.
		expect(providersConfigSchema.safeParse(config).success).toBe(true);
	});
});

// ===========================================================================
// Translator — migration records + full-map round trip
// ===========================================================================

describe("translateLegacyPositronSettings — migration records", () => {
	it("records source-to-destination migrations with log-safe values", () => {
		const { migrations } = translate({
			"authentication.openai-api.baseUrl": "https://openai.example.com",
			"authentication.openai-api.customHeaders": {
				"x-api-key": "sk-secret-token",
				"x-team": "data-science",
			},
			"authentication.aws.credentials": { AWS_PROFILE: "default", AWS_REGION: "us-east-1" },
		});
		expect(migrations).toEqual([
			{
				source: "authentication.openai-api.baseUrl",
				destination: "providers.openai.baseUrl",
				value: '"https://openai.example.com"',
			},
			// Header values can carry auth tokens; only names are logged.
			{
				source: "authentication.openai-api.customHeaders",
				destination: "providers.openai.customHeaders",
				value: "[x-api-key, x-team]",
			},
			{
				source: "authentication.aws.credentials",
				destination: "providers.bedrock.aws.profile",
				value: '"default"',
			},
			{
				source: "authentication.aws.credentials",
				destination: "providers.bedrock.aws.region",
				value: '"us-east-1"',
			},
		]);
	});

	it("every legacy key maps to config the full schema accepts", () => {
		const values: Record<string, unknown> = {};
		for (const key of legacySettingKeys()) {
			if (key.endsWith(".credentials")) {
				values[key] = {
					AWS_PROFILE: "default",
					AWS_REGION: "us-east-1",
					GOOGLE_VERTEX_PROJECT: "proj",
					GOOGLE_VERTEX_LOCATION: "us-central1",
					SNOWFLAKE_ACCOUNT: "MYORG-MYACCT",
					SNOWFLAKE_HOME: "/opt/snowflake",
					SNOWFLAKE_HOST: "acct.snowflakecomputing.com",
					DATABRICKS_HOST: "dbx.example.com",
				};
			} else if (key.endsWith(".baseUrl")) {
				values[key] = "https://gateway.example.com";
			} else if (key.endsWith(".customHeaders")) {
				values[key] = { "x-team": "data-science" };
			} else if (key.startsWith("positron.assistant.models.overrides.")) {
				values[key] = [{ name: "Team Model", identifier: "team-model-1", maxInputTokens: 100_000 }];
			} else if (key.endsWith(".enable") || key.endsWith(".enabled")) {
				values[key] = true;
			} else {
				throw new Error(`unhandled legacy key ${key}; add a branch with a realistic value`);
			}
		}
		const { config, migrations, logger } = translate(values);
		expect(providersConfigSchema.safeParse(config).success).toBe(true);
		expect(logger.warn).not.toHaveBeenCalled();
		// Every distinct legacy key produced at least one record.
		const sources = new Set(migrations.map((m) => m.source));
		expect(sources.size).toBe(legacySettingKeys().length);
	});

	it("legacySettingKeys covers a spot-check of each family", () => {
		for (const key of [
			"authentication.anthropic.baseUrl",
			"authentication.github.customHeaders",
			"authentication.aws.credentials",
			"authentication.databricks.credentials",
			"authentication.snowflake.customHeaders",
			"positron.assistant.provider.githubCopilot.enable",
			"assistant.provider.googleVertex.enabled",
			"positron.assistant.models.overrides.positAI",
		]) {
			expect(legacySettingKeys()).toContain(key);
		}
	});

	it("warns once per dropped key across repeated translations sharing state", () => {
		const logger = makeLogger();
		const warnedKeys = new Set<string>();
		const reader = readerOf({
			// Wrong-shaped section hit multiple times by the snowflake reads.
			"authentication.snowflake.credentials": "not-an-object",
			"authentication.anthropic.baseUrl": "https://proxy.example.com",
		});
		translateLegacyPositronSettings(reader, logger, warnedKeys);
		translateLegacyPositronSettings(reader, logger, warnedKeys);
		const drops = logger.warn.mock.calls.filter(([msg]) => String(msg).includes("Ignoring"));
		expect(drops).toHaveLength(1);
	});
});

// ===========================================================================
// Sources — legacy-positron (reader-backed)
// ===========================================================================

function makeSources(
	values: Record<string, unknown>,
	env: Record<string, string | undefined> = {},
) {
	const logger = makeLogger();
	let fireChange: (() => void) | undefined;
	const disposed = { value: false };
	const reader: LegacySettingsReader = {
		get: (key) => values[key],
		watch: (onChange) => {
			fireChange = onChange;
			return {
				dispose: () => {
					disposed.value = true;
				},
			};
		},
	};
	const [enforced, legacy] = createLegacyPositronSourceProviders(
		{ legacyPositronSettings: reader, legacyPositronEnforcedSettings: true },
		env,
	);
	return { enforced, legacy, logger, fire: () => fireChange?.(), disposed };
}

describe("createLegacyPositronSourceProviders — legacy-positron source", () => {
	it("reads the legacy settings into a legacy-positron source", () => {
		const { legacy } = makeSources({
			"authentication.anthropic.baseUrl": "https://proxy.example.com",
		});
		const source = legacy.read().source;
		expect(source).toMatchObject({
			kind: "legacy-positron",
			config: { providers: { anthropic: { baseUrl: "https://proxy.example.com" } } },
		});
	});

	it("returns no source when nothing is set", () => {
		const { legacy, logger } = makeSources({});
		expect(legacy.read()).toEqual({ source: undefined, issues: [] });
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("delegates watch to the reader", () => {
		const { legacy, fire, disposed } = makeSources({});
		const onChange = vi.fn();
		const sub = legacy.watch?.(onChange);
		fire();
		expect(onChange).toHaveBeenCalledTimes(1);
		sub?.dispose();
		expect(disposed.value).toBe(true);
	});
});

// ===========================================================================
// Sources — legacy-positron-enforced (env-payload-backed)
// ===========================================================================

function readEnforced(payload: unknown, extraEnv: Record<string, string | undefined> = {}) {
	const { enforced, logger } = makeSources(
		{},
		{
			...extraEnv,
			[POSITRON_ENFORCED_SETTINGS_ENV_VAR]:
				payload === undefined ? undefined : JSON.stringify(payload),
		},
	);
	const report = enforced.read();
	return { source: report.source, issues: report.issues, logger, provider: enforced };
}

describe("createLegacyPositronSourceProviders — enforced envelope", () => {
	it("unset env var → no source", () => {
		const { source, issues, logger } = readEnforced(undefined);
		expect(source).toBeUndefined();
		expect(issues).toEqual([]);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("malformed JSON → reports the current issue on every read and skips the source", () => {
		const { enforced, logger } = makeSources(
			{},
			{ [POSITRON_ENFORCED_SETTINGS_ENV_VAR]: "{not json" },
		);
		const first = enforced.read();
		const second = enforced.read();
		expect(first.source).toBeUndefined();
		expect(first.issues).toEqual(second.issues);
		expect(first.issues[0].message).toContain("Failed to parse");
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("non-object payload (array) → warn and skip", () => {
		const { source, issues, logger } = readEnforced(["authentication.anthropic.baseUrl"]);
		expect(source).toBeUndefined();
		expect(issues[0].message).toContain("not a JSON object");
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("payload with no provider-relevant keys is inert (no source, no warnings)", () => {
		const { source, issues, logger } = readEnforced({
			"editor.formatOnSave": false,
			"[r]": { "editor.formatOnSave": true },
		});
		expect(source).toBeUndefined();
		expect(issues).toEqual([]);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("ignores language-override blocks even when they contain provider keys", () => {
		const { source } = readEnforced({
			"[r]": { "authentication.anthropic.baseUrl": "https://from-lang-block.example.com" },
		});
		expect(source).toBeUndefined();
	});
});

describe("createLegacyPositronSourceProviders — enforced translation", () => {
	it("translates the full map into a legacy-positron-enforced source", () => {
		const { source } = readEnforced({
			"authentication.anthropic.baseUrl": "https://proxy.example.com",
			"authentication.anthropic.customHeaders": { "x-team": "ml" },
			"positron.assistant.provider.openAI.enable": false,
			"positron.assistant.models.overrides.anthropic": [
				{ name: "Pinned", identifier: "claude-sonnet-4-5" },
			],
		});
		expect(source?.kind).toBe("legacy-positron-enforced");
		expect(source?.label).toBe(POSITRON_ENFORCED_SETTINGS_ENV_VAR);
		expect(source?.config.providers?.anthropic?.baseUrl).toBe("https://proxy.example.com");
		expect(source?.config.providers?.anthropic?.customHeaders).toEqual({ "x-team": "ml" });
		// Enablement and model pinning translate at enforced rank too — the
		// enforced source applies the SAME map as the reader layer.
		expect(source?.config.providers?.openai?.enabled).toBe(false);
		expect(source?.config.providers?.anthropic?.models?.discovery).toBe("off");
		expect(source?.config.providers?.anthropic?.models?.custom?.[0]?.id).toBe("claude-sonnet-4-5");
	});

	it("applies bare-host base URL correction", () => {
		const { source } = readEnforced({
			"authentication.openai-api.baseUrl": "https://api.openai.com",
		});
		expect(source?.config.providers?.openai?.baseUrl).toBe("https://api.openai.com/v1");
	});

	it("reads aws/snowflake/databricks credential sections", () => {
		const { source } = readEnforced({
			"authentication.aws.credentials": { AWS_REGION: "eu-west-1" },
			"authentication.snowflake.credentials": {
				SNOWFLAKE_HOST: "acct.snowflakecomputing.com",
				SNOWFLAKE_ACCOUNT: "acct",
			},
			"authentication.databricks.credentials": { DATABRICKS_HOST: "dbx.example.com" },
		});
		expect(source?.config.providers?.bedrock).toEqual({ aws: { region: "eu-west-1" } });
		expect(source?.config.providers?.["snowflake-cortex"]).toEqual({
			snowflake: { host: "acct.snowflakecomputing.com", account: "acct" },
		});
		expect(source?.config.providers?.databricks).toEqual({
			databricks: { host: "dbx.example.com" },
		});
	});

	it("drops a wrong-typed key with a warning, keeping the rest", () => {
		const { source, issues, logger } = readEnforced({
			"authentication.anthropic.baseUrl": 42,
			"authentication.anthropic.customHeaders": { "x-team": "ml" },
		});
		expect(source?.config.providers?.anthropic).toEqual({ customHeaders: { "x-team": "ml" } });
		expect(issues[0]).toMatchObject({
			path: ["authentication.anthropic.baseUrl"],
			message: expect.stringContaining('"authentication.anthropic.baseUrl"'),
		});
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("reports a dropped key on every re-read without logging", () => {
		const { provider, logger } = readEnforced({
			"authentication.snowflake.credentials": "not-an-object",
			"authentication.anthropic.baseUrl": "https://proxy.example.com",
		});
		const first = provider.read();
		const second = provider.read();
		expect(first.issues).toHaveLength(1);
		expect(second.issues).toEqual(first.issues);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("never falls back to ambient env vars (payload-only reads)", () => {
		// SNOWFLAKE_HOST is present in the process env but NOT in the enforced
		// payload — it must not be promoted to enforced rank.
		const { source } = readEnforced(
			{ "authentication.anthropic.baseUrl": "https://proxy.example.com" },
			{ SNOWFLAKE_HOST: "ambient.snowflakecomputing.com", AWS_REGION: "ambient-region" },
		);
		expect(source?.config.providers?.["snowflake-cortex"]).toBeUndefined();
		expect(source?.config.providers?.bedrock).toBeUndefined();
	});

	it("a valid non-empty payload emits no warnings", () => {
		// The legacy channel is still the documented admin channel this release;
		// deprecation messaging belongs in admin-facing docs, not user logs.
		const { source, issues, logger } = readEnforced({
			"authentication.anthropic.baseUrl": "https://proxy.example.com",
		});
		expect(source).toBeDefined();
		expect(issues).toEqual([]);
		expect(logger.warn).not.toHaveBeenCalled();
	});
});
