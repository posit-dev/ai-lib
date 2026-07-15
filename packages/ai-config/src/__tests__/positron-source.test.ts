/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the pure `buildAuthenticationFragment` — the vscode-free half of
 * the Positron `authentication.*` host source. The reader is a plain fake, so
 * these run in any environment (no `vscode`, no `process`).
 */

import { describe, expect, it } from "vitest";

import {
	buildAuthenticationFragment,
	type PositronAuthSettingDescriptor,
	type PositronAuthSettingReader,
} from "../positron/authentication-fragment.js";

function fakeReader(
	overrides: {
		baseUrls?: Record<string, string>;
		customHeaders?: Record<string, Record<string, string>>;
		awsRegion?: string;
		snowflake?: { host?: string; account?: string };
		databricks?: { host?: string };
	} = {},
): PositronAuthSettingReader {
	return {
		getBaseUrl: (configKey) => overrides.baseUrls?.[configKey],
		getCustomHeaders: (configKey) => overrides.customHeaders?.[configKey],
		getAwsRegion: () => overrides.awsRegion,
		getSnowflake: () => overrides.snowflake,
		getDatabricks: () => overrides.databricks,
	};
}

const ANTHROPIC: PositronAuthSettingDescriptor = {
	providerId: "anthropic",
	configKey: "anthropic",
	read: "api-key-connection",
};
// `openai` maps to the legacy `openai-api` config section.
const OPENAI: PositronAuthSettingDescriptor = {
	providerId: "openai",
	configKey: "openai-api",
	read: "api-key-connection",
};
const BEDROCK: PositronAuthSettingDescriptor = {
	providerId: "bedrock",
	configKey: "aws",
	read: "aws-region",
};
const SNOWFLAKE: PositronAuthSettingDescriptor = {
	providerId: "snowflake-cortex",
	configKey: "snowflake",
	read: "snowflake",
};
const DATABRICKS: PositronAuthSettingDescriptor = {
	providerId: "databricks",
	configKey: "databricks",
	read: "databricks",
};

describe("buildAuthenticationFragment", () => {
	it("returns an empty fragment when nothing is set", () => {
		const fragment = buildAuthenticationFragment(fakeReader(), [ANTHROPIC, BEDROCK, SNOWFLAKE]);
		expect(fragment).toEqual({});
	});

	it("emits baseUrl + customHeaders for an api-key provider, keyed by provider id", () => {
		const reader = fakeReader({
			baseUrls: { anthropic: "https://custom.anthropic.example/v1" },
			customHeaders: { anthropic: { "x-tenancy": "team-42" } },
		});
		const fragment = buildAuthenticationFragment(reader, [ANTHROPIC]);
		expect(fragment).toEqual({
			providers: {
				anthropic: {
					baseUrl: "https://custom.anthropic.example/v1",
					customHeaders: { "x-tenancy": "team-42" },
				},
			},
		});
	});

	it("reads api-key settings under the descriptor's configKey (openai → openai-api)", () => {
		const reader = fakeReader({
			baseUrls: { "openai-api": "https://openai.example/v1" },
		});
		const fragment = buildAuthenticationFragment(reader, [OPENAI]);
		expect(fragment).toEqual({
			providers: { openai: { baseUrl: "https://openai.example/v1" } },
		});
	});

	it("omits unset keys and normalizes empty base URL / empty headers", () => {
		const reader = fakeReader({
			baseUrls: { anthropic: "" }, // empty → omitted
			customHeaders: { anthropic: {} }, // empty map → omitted
		});
		const fragment = buildAuthenticationFragment(reader, [ANTHROPIC]);
		// The whole block is empty, so no provider entry is emitted at all.
		expect(fragment).toEqual({});
	});

	it("emits only customHeaders when baseUrl is unset", () => {
		const reader = fakeReader({
			customHeaders: { anthropic: { "x-a": "1" } },
		});
		const fragment = buildAuthenticationFragment(reader, [ANTHROPIC]);
		expect(fragment).toEqual({
			providers: { anthropic: { customHeaders: { "x-a": "1" } } },
		});
	});

	it("emits aws.region for the aws-region descriptor (bedrock)", () => {
		const fragment = buildAuthenticationFragment(fakeReader({ awsRegion: "eu-west-1" }), [BEDROCK]);
		expect(fragment).toEqual({
			providers: { bedrock: { aws: { region: "eu-west-1" } } },
		});
	});

	it("omits bedrock when no region is set", () => {
		const fragment = buildAuthenticationFragment(fakeReader(), [BEDROCK]);
		expect(fragment).toEqual({});
	});

	it("emits snowflake host/account (+ customHeaders) under snowflake-cortex", () => {
		const reader = fakeReader({
			snowflake: { host: "h.snowflakecomputing.com", account: "org-acct" },
			customHeaders: { snowflake: { "x-sf": "y" } },
		});
		const fragment = buildAuthenticationFragment(reader, [SNOWFLAKE]);
		expect(fragment).toEqual({
			providers: {
				"snowflake-cortex": {
					snowflake: { host: "h.snowflakecomputing.com", account: "org-acct" },
					customHeaders: { "x-sf": "y" },
				},
			},
		});
	});

	it("emits only the set snowflake sub-keys", () => {
		const reader = fakeReader({ snowflake: { account: "org-acct" } });
		const fragment = buildAuthenticationFragment(reader, [SNOWFLAKE]);
		expect(fragment).toEqual({
			providers: { "snowflake-cortex": { snowflake: { account: "org-acct" } } },
		});
	});

	it("emits the databricks host as baseUrl (+ customHeaders), keyed by provider id", () => {
		const reader = fakeReader({
			databricks: { host: "https://adb-123.4.azuredatabricks.net" },
			customHeaders: { databricks: { "x-databricks-use-coding-agent-mode": "true" } },
		});
		const fragment = buildAuthenticationFragment(reader, [DATABRICKS]);
		expect(fragment).toEqual({
			providers: {
				databricks: {
					baseUrl: "https://adb-123.4.azuredatabricks.net",
					customHeaders: { "x-databricks-use-coding-agent-mode": "true" },
				},
			},
		});
	});

	it("applies the descriptor's normalizeBaseUrl to the databricks host", () => {
		const normalizeBaseUrl = (url: string) => `https://${url.replace(/\/+$/, "")}`;
		const reader = fakeReader({ databricks: { host: "my-workspace.cloud.databricks.com/" } });
		const fragment = buildAuthenticationFragment(reader, [{ ...DATABRICKS, normalizeBaseUrl }]);
		expect(fragment).toEqual({
			providers: { databricks: { baseUrl: "https://my-workspace.cloud.databricks.com" } },
		});
	});

	it("omits databricks when no host is set", () => {
		const fragment = buildAuthenticationFragment(fakeReader(), [DATABRICKS]);
		expect(fragment).toEqual({});
	});

	it("applies the descriptor's normalizeBaseUrl to a set base URL", () => {
		const normalizeBaseUrl = (url: string) =>
			url === "https://bare.example" ? "https://bare.example/v1" : url;
		const descriptor: PositronAuthSettingDescriptor = { ...ANTHROPIC, normalizeBaseUrl };
		const reader = fakeReader({ baseUrls: { anthropic: "https://bare.example" } });
		const fragment = buildAuthenticationFragment(reader, [descriptor]);
		expect(fragment).toEqual({
			providers: { anthropic: { baseUrl: "https://bare.example/v1" } },
		});
	});

	it("passes a value the normalizer leaves alone through unchanged", () => {
		const normalizeBaseUrl = (url: string) =>
			url === "https://bare.example" ? "https://bare.example/v1" : url;
		const descriptor: PositronAuthSettingDescriptor = { ...ANTHROPIC, normalizeBaseUrl };
		const reader = fakeReader({ baseUrls: { anthropic: "https://custom.example/anthropic" } });
		const fragment = buildAuthenticationFragment(reader, [descriptor]);
		expect(fragment).toEqual({
			providers: { anthropic: { baseUrl: "https://custom.example/anthropic" } },
		});
	});

	it("does not invoke the normalizer when baseUrl is unset", () => {
		let calls = 0;
		const normalizeBaseUrl = (url: string) => {
			calls++;
			return url;
		};
		const descriptor: PositronAuthSettingDescriptor = { ...ANTHROPIC, normalizeBaseUrl };
		const fragment = buildAuthenticationFragment(fakeReader(), [descriptor]);
		expect(fragment).toEqual({});
		expect(calls).toBe(0);
	});

	it("does not invoke the normalizer when baseUrl is an empty string", () => {
		let calls = 0;
		const normalizeBaseUrl = (url: string) => {
			calls++;
			return url;
		};
		const descriptor: PositronAuthSettingDescriptor = { ...ANTHROPIC, normalizeBaseUrl };
		const reader = fakeReader({ baseUrls: { anthropic: "" } });
		const fragment = buildAuthenticationFragment(reader, [descriptor]);
		expect(fragment).toEqual({});
		expect(calls).toBe(0);
	});

	it("behaves as before for descriptors without normalizeBaseUrl", () => {
		const reader = fakeReader({ baseUrls: { anthropic: "https://bare.example" } });
		const fragment = buildAuthenticationFragment(reader, [ANTHROPIC]);
		expect(fragment).toEqual({
			providers: { anthropic: { baseUrl: "https://bare.example" } },
		});
	});

	it("builds a multi-provider fragment, omitting providers with nothing set", () => {
		const reader = fakeReader({
			baseUrls: { anthropic: "https://a.example" },
			awsRegion: "us-west-2",
			// openai + snowflake unset → omitted
		});
		const fragment = buildAuthenticationFragment(reader, [ANTHROPIC, OPENAI, BEDROCK, SNOWFLAKE]);
		expect(fragment).toEqual({
			providers: {
				anthropic: { baseUrl: "https://a.example" },
				bedrock: { aws: { region: "us-west-2" } },
			},
		});
	});
});
