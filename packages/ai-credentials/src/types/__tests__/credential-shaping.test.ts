/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Credential-side tests for the pure Snowflake URL preference.
 *
 * `shapeCredentials` builds the Snowflake Cortex base URL from `host` when
 * present, falling back to `account`. This preference is what makes the
 * Phase 6 host-layer merge observable as a URL flip: when a user `providers.json`
 * supplies `account` and the `authentication.*` host layer supplies `host`, the
 * resolver deep-merges them to `{ host, account }` and the URL is built from
 * `host` (see the resolver-side merge test in ai-config's resolve-catalog test).
 */

import { describe, expect, it } from "vitest";

import { type CredentialConfig, shapeCredentials } from "../credential-shaping.js";

const SNOWFLAKE = { authProviderId: "snowflake-cortex", credentialType: "apikey" } as const;
const AWS = { authProviderId: "bedrock", credentialType: "aws-credentials" } as const;
const GOOGLE = { authProviderId: "google-vertex", credentialType: "google-cloud" } as const;
const ANTHROPIC = { authProviderId: "anthropic-api", credentialType: "apikey" } as const;
const OPENAI = { authProviderId: "openai-api", credentialType: "apikey" } as const;

function fakeConfig(snowflake?: { host?: string; account?: string }): CredentialConfig {
	return {
		getBaseUrl: () => undefined,
		getCustomHeaders: () => undefined,
		getAws: () => undefined,
		getSnowflake: () => snowflake,
		getDatabricks: () => undefined,
	};
}

/** A CredentialConfig with all readers stubbed to undefined, then overridden. */
function config(overrides: Partial<CredentialConfig> = {}): CredentialConfig {
	return {
		getBaseUrl: () => undefined,
		getCustomHeaders: () => undefined,
		getAws: () => undefined,
		getSnowflake: () => undefined,
		getDatabricks: () => undefined,
		...overrides,
	};
}

describe("shapeCredentials — Snowflake host-over-account URL", () => {
	it("builds the URL from host, not account, when both are present", () => {
		const config = fakeConfig({ host: "h.snowflakecomputing.com", account: "org-acct" });
		expect(shapeCredentials("snowflake-cortex", SNOWFLAKE, "tok", config)).toMatchObject({
			type: "apikey",
			baseUrl: "https://h.snowflakecomputing.com/api/v2/cortex/v1",
		});
	});

	it("falls back to account when only account is present", () => {
		const config = fakeConfig({ account: "org-acct" });
		expect(shapeCredentials("snowflake-cortex", SNOWFLAKE, "tok", config)).toMatchObject({
			baseUrl: "https://org-acct.snowflakecomputing.com/api/v2/cortex/v1",
		});
	});

	it("leaves the URL undefined when neither host nor account is present", () => {
		expect(shapeCredentials("snowflake-cortex", SNOWFLAKE, "tok", fakeConfig())).toMatchObject({
			baseUrl: undefined,
		});
	});
});

// Parity coverage ported from the removed ai-provider-bridge positron auth suite.

describe("shapeCredentials — AWS credentials JSON", () => {
	const awsToken = JSON.stringify({
		accessKeyId: "AKIA",
		secretAccessKey: "secret",
		sessionToken: "sess",
	});

	it("parses the JSON token and applies the configured region", () => {
		expect(
			shapeCredentials(
				"bedrock",
				AWS,
				awsToken,
				config({ getAws: () => ({ region: "eu-west-1" }) }),
			),
		).toEqual({
			type: "aws-credentials",
			region: "eu-west-1",
			accessKeyId: "AKIA",
			secretAccessKey: "secret",
			sessionToken: "sess",
		});
	});

	it("defaults the region to us-east-1 when none is configured", () => {
		expect(shapeCredentials("bedrock", AWS, awsToken, config())).toMatchObject({
			region: "us-east-1",
		});
	});

	it("returns null for a non-JSON token", () => {
		expect(shapeCredentials("bedrock", AWS, "not-json", config())).toBeNull();
	});

	it("returns null when accessKeyId or secretAccessKey is missing", () => {
		expect(
			shapeCredentials("bedrock", AWS, JSON.stringify({ accessKeyId: "AKIA" }), config()),
		).toBeNull();
	});

	it("includes the configured profile", () => {
		const cfg = config({ getAws: () => ({ region: "eu-west-1", profile: "work" }) });
		expect(shapeCredentials("bedrock", AWS, awsToken, cfg)).toMatchObject({
			type: "aws-credentials",
			region: "eu-west-1",
			profile: "work",
		});
	});
});

describe("shapeCredentials — Google Cloud credentials JSON", () => {
	it("parses project/location/token for a brokered token", () => {
		const token = JSON.stringify({ project: "p", location: "us-central1", token: "gcp-tok" });
		expect(shapeCredentials("google-vertex", GOOGLE, token, config())).toEqual({
			type: "google-cloud",
			project: "p",
			location: "us-central1",
			accessToken: "gcp-tok",
		});
	});

	it("omits accessToken for the ADC fallback when no token is present", () => {
		const token = JSON.stringify({ project: "p", location: "us-central1" });
		expect(shapeCredentials("google-vertex", GOOGLE, token, config())).toEqual({
			type: "google-cloud",
			project: "p",
			location: "us-central1",
		});
	});

	it("returns null for a non-JSON token", () => {
		expect(shapeCredentials("google-vertex", GOOGLE, "not-json", config())).toBeNull();
	});

	it("returns null when project or location is missing", () => {
		expect(
			shapeCredentials("google-vertex", GOOGLE, JSON.stringify({ project: "p" }), config()),
		).toBeNull();
		expect(
			shapeCredentials("google-vertex", GOOGLE, JSON.stringify({ location: "l" }), config()),
		).toBeNull();
	});
});

describe("shapeCredentials — apikey baseUrl + customHeaders", () => {
	it("reads baseUrl and customHeaders under the provider configKey", () => {
		const cfg = config({
			getBaseUrl: ({ configKey }) => (configKey === "anthropic" ? "https://proxy" : undefined),
			getCustomHeaders: ({ configKey }) =>
				configKey === "anthropic" ? { "x-tenancy": "t" } : undefined,
		});
		expect(shapeCredentials("anthropic", ANTHROPIC, "sk", cfg)).toEqual({
			type: "apikey",
			apiKey: "sk",
			baseUrl: "https://proxy",
			customHeaders: { "x-tenancy": "t" },
		});
	});

	it("normalizes an empty customHeaders object to undefined", () => {
		expect(
			shapeCredentials("anthropic", ANTHROPIC, "sk", config({ getCustomHeaders: () => ({}) })),
		).toMatchObject({ customHeaders: undefined });
	});

	it("uses the authProviderId as configKey when no override exists (openai-api)", () => {
		const cfg = config({
			getCustomHeaders: ({ configKey }) =>
				configKey === "openai-api" ? { "x-flag": "1" } : undefined,
		});
		expect(shapeCredentials("openai", OPENAI, "sk", cfg)).toMatchObject({
			customHeaders: { "x-flag": "1" },
		});
	});
});

// A `providers.custom` entry's id is the user's chosen name, so shaping can't
// recognize it by id: the readers have to be told *which* provider is being
// resolved, and structured base-URL derivation has to be declared on the
// mapping. Without both, a named `type: "aws"` / `type: "snowflake"` entry
// inherits bedrock's region or loses its Cortex URL.
describe("shapeCredentials — providers.custom entries", () => {
	const CUSTOM_AWS = {
		authProviderId: "my-bedrock",
		credentialType: "aws-credentials",
	} as const;
	const CUSTOM_SNOWFLAKE = {
		authProviderId: "my-snow",
		credentialType: "apikey",
		structuredBaseUrl: "snowflake",
	} as const;
	const CUSTOM_GATEWAY = { authProviderId: "my-gateway", credentialType: "apikey" } as const;

	const awsToken = JSON.stringify({ accessKeyId: "AKIA", secretAccessKey: "secret" });

	it("asks getAws for the custom entry's own key, not the built-in bedrock one", () => {
		const cfg = config({
			getAws: ({ providerId }) =>
				providerId === "my-bedrock" ? { region: "ca-central-1" } : { region: "us-west-2" },
		});
		expect(shapeCredentials("my-bedrock", CUSTOM_AWS, awsToken, cfg)).toMatchObject({
			region: "ca-central-1",
		});
	});

	it("derives the Cortex URL from the custom entry's own host", () => {
		const cfg = config({
			getSnowflake: ({ providerId }) =>
				providerId === "my-snow" ? { host: "mine.snowflakecomputing.com" } : undefined,
		});
		expect(shapeCredentials("my-snow", CUSTOM_SNOWFLAKE, "tok", cfg)).toMatchObject({
			baseUrl: "https://mine.snowflakecomputing.com/api/v2/cortex/v1",
		});
	});

	it("leaves a plain custom entry on the baseUrl path", () => {
		// The declaration is what selects structured derivation: an entry that
		// doesn't declare it must not pick up another provider's Snowflake config.
		const cfg = config({
			getBaseUrl: () => "https://gateway.example.com",
			getSnowflake: () => ({ host: "someone-else.snowflakecomputing.com" }),
		});
		expect(shapeCredentials("my-gateway", CUSTOM_GATEWAY, "sk", cfg)).toMatchObject({
			baseUrl: "https://gateway.example.com",
		});
	});

	// A custom entry may legally be named `snowflake`, which is also the configKey
	// `snowflake-cortex` derives. Two providers, one configKey: readers can only
	// tell them apart by provider id.
	it("distinguishes an entry named `snowflake` from the built-in snowflake-cortex", () => {
		const NAMED_SNOWFLAKE = {
			authProviderId: "snowflake",
			credentialType: "apikey",
			structuredBaseUrl: "snowflake",
		} as const;
		const hosts: Record<string, string> = {
			snowflake: "mine.snowflakecomputing.com",
			"snowflake-cortex": "corp.snowflakecomputing.com",
		};
		const cfg = config({
			getSnowflake: ({ providerId }) => ({ host: hosts[providerId] }),
		});

		expect(shapeCredentials("snowflake", NAMED_SNOWFLAKE, "tok", cfg)).toMatchObject({
			baseUrl: "https://mine.snowflakecomputing.com/api/v2/cortex/v1",
		});
		expect(shapeCredentials("snowflake-cortex", SNOWFLAKE, "tok", cfg)).toMatchObject({
			baseUrl: "https://corp.snowflakecomputing.com/api/v2/cortex/v1",
		});
	});
});
