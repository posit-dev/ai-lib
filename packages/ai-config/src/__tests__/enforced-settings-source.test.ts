/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// PROVIDER-SETTINGS-MIGRATION(host-enforced) gate: delete this file with the module.

import { describe, expect, it, vi } from "vitest";

import type { PositronAuthSettingDescriptor } from "../positron/authentication-fragment.js";
import {
	createPositronEnforcedConfigSource,
	POSITRON_ENFORCED_SETTINGS_ENV_VAR,
} from "../positron/enforced-settings-source.js";

const DESCRIPTORS: PositronAuthSettingDescriptor[] = [
	{ providerId: "anthropic", configKey: "anthropic", read: "api-key-connection" },
	{
		providerId: "openai",
		configKey: "openai-api",
		read: "api-key-connection",
		normalizeBaseUrl: (url) => `${url}/v1`,
	},
	{ providerId: "bedrock", configKey: "aws", read: "aws-region" },
	{ providerId: "snowflake-cortex", configKey: "snowflake", read: "snowflake" },
	{ providerId: "databricks", configKey: "databricks", read: "databricks" },
];

function makeLogger() {
	return { debug: vi.fn(), warn: vi.fn() };
}

function readSource(payload: unknown, env: Record<string, string | undefined> = {}) {
	const logger = makeLogger();
	const provider = createPositronEnforcedConfigSource(
		DESCRIPTORS,
		{
			...env,
			[POSITRON_ENFORCED_SETTINGS_ENV_VAR]:
				payload === undefined ? undefined : JSON.stringify(payload),
		},
		logger,
	);
	return { source: provider.read(), logger, provider };
}

describe("createPositronEnforcedConfigSource — envelope", () => {
	it("unset env var → no source", () => {
		const { source, logger } = readSource(undefined);
		expect(source).toBeUndefined();
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("malformed JSON → warn and skip the whole source", () => {
		const logger = makeLogger();
		const provider = createPositronEnforcedConfigSource(
			DESCRIPTORS,
			{ [POSITRON_ENFORCED_SETTINGS_ENV_VAR]: "{not json" },
			logger,
		);
		expect(provider.read()).toBeUndefined();
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to parse"));
	});

	it("non-object payload (array) → warn and skip", () => {
		const { source, logger } = readSource(["authentication.anthropic.baseUrl"]);
		expect(source).toBeUndefined();
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("not a JSON object"));
	});

	it("payload with no provider-relevant keys is inert (no source, no warnings)", () => {
		const { source, logger } = readSource({
			"editor.formatOnSave": false,
			"[r]": { "editor.formatOnSave": true },
		});
		expect(source).toBeUndefined();
		expect(logger.warn).not.toHaveBeenCalled();
	});
});

describe("createPositronEnforcedConfigSource — translation", () => {
	it("translates connection keys into a host-enforced source", () => {
		const { source } = readSource({
			"authentication.anthropic.baseUrl": "https://proxy.example.com",
			"authentication.anthropic.customHeaders": { "x-team": "ml" },
		});
		expect(source?.kind).toBe("host-enforced");
		expect(source?.label).toBe(POSITRON_ENFORCED_SETTINGS_ENV_VAR);
		expect(source?.config.providers?.anthropic).toEqual({
			baseUrl: "https://proxy.example.com",
			customHeaders: { "x-team": "ml" },
		});
	});

	it("applies the descriptor's normalizeBaseUrl hook", () => {
		const { source } = readSource({
			"authentication.openai-api.baseUrl": "https://api.openai.com",
		});
		expect(source?.config.providers?.openai?.baseUrl).toBe("https://api.openai.com/v1");
	});

	it("reads aws/snowflake/databricks credential sections", () => {
		const { source } = readSource({
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

	it("ignores language-override blocks even when they contain provider keys", () => {
		const { source } = readSource({
			"[r]": { "authentication.anthropic.baseUrl": "https://from-lang-block.example.com" },
		});
		expect(source).toBeUndefined();
	});
});

describe("createPositronEnforcedConfigSource — per-key tolerance", () => {
	it("drops a wrong-typed key with a warning, keeping the rest", () => {
		const { source, logger } = readSource({
			"authentication.anthropic.baseUrl": 42,
			"authentication.anthropic.customHeaders": { "x-team": "ml" },
		});
		expect(source?.config.providers?.anthropic).toEqual({ customHeaders: { "x-team": "ml" } });
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('ignoring "authentication.anthropic.baseUrl"'),
		);
	});

	it("drops non-string-map customHeaders with a warning", () => {
		const { source, logger } = readSource({
			"authentication.anthropic.baseUrl": "https://proxy.example.com",
			"authentication.anthropic.customHeaders": { "x-count": 3 },
		});
		expect(source?.config.providers?.anthropic).toEqual({
			baseUrl: "https://proxy.example.com",
		});
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('ignoring "authentication.anthropic.customHeaders"'),
		);
	});

	it("warns once per dropped key, not per field read or per re-read", () => {
		const logger = makeLogger();
		const provider = createPositronEnforcedConfigSource(
			DESCRIPTORS,
			{
				[POSITRON_ENFORCED_SETTINGS_ENV_VAR]: JSON.stringify({
					// Wrong-shaped section hit three times by the snowflake reads.
					"authentication.snowflake.credentials": "not-an-object",
					"authentication.anthropic.baseUrl": "https://proxy.example.com",
				}),
			},
			logger,
		);
		provider.read();
		provider.read(); // watch-seam rebuilds re-read; warnings must not repeat
		const drops = logger.warn.mock.calls.filter(([msg]) => String(msg).includes("ignoring"));
		expect(drops).toHaveLength(1);
	});

	it("drops a non-object credentials section with a warning", () => {
		const { source, logger } = readSource({
			"authentication.aws.credentials": "us-east-1",
			"authentication.anthropic.baseUrl": "https://proxy.example.com",
		});
		expect(source?.config.providers?.bedrock).toBeUndefined();
		expect(source?.config.providers?.anthropic?.baseUrl).toBe("https://proxy.example.com");
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('ignoring "authentication.aws.credentials"'),
		);
	});
});

describe("createPositronEnforcedConfigSource — enforcement isolation", () => {
	it("never falls back to ambient env vars (payload-only reads)", () => {
		// SNOWFLAKE_HOST is present in the process env but NOT in the enforced
		// payload — it must not be promoted to enforced rank. (The `host`
		// reader's env fallbacks are a convenience this source must never copy.)
		const { source } = readSource(
			{ "authentication.anthropic.baseUrl": "https://proxy.example.com" },
			{ SNOWFLAKE_HOST: "ambient.snowflakecomputing.com", AWS_REGION: "ambient-region" },
		);
		expect(source?.config.providers?.["snowflake-cortex"]).toBeUndefined();
		expect(source?.config.providers?.bedrock).toBeUndefined();
	});
});

describe("createPositronEnforcedConfigSource — quiet on the happy path", () => {
	it("a valid non-empty payload emits no warnings", () => {
		// The legacy channel is still the documented admin channel this release;
		// deprecation messaging belongs in admin-facing docs, not user logs.
		const logger = makeLogger();
		const provider = createPositronEnforcedConfigSource(
			DESCRIPTORS,
			{
				[POSITRON_ENFORCED_SETTINGS_ENV_VAR]: JSON.stringify({
					"authentication.anthropic.baseUrl": "https://proxy.example.com",
				}),
			},
			logger,
		);
		expect(provider.read()).toBeDefined();
		expect(logger.warn).not.toHaveBeenCalled();
	});
});
