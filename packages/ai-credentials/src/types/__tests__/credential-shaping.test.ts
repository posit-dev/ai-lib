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

import { type CredentialConfig, shapeCredentials } from "../credential-shaping";

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
	};
}

/** A CredentialConfig with all readers stubbed to undefined, then overridden. */
function config(overrides: Partial<CredentialConfig> = {}): CredentialConfig {
	return {
		getBaseUrl: () => undefined,
		getCustomHeaders: () => undefined,
		getAws: () => undefined,
		getSnowflake: () => undefined,
		...overrides,
	};
}

describe("shapeCredentials — Snowflake host-over-account URL", () => {
	it("builds the URL from host, not account, when both are present", () => {
		const config = fakeConfig({ host: "h.snowflakecomputing.com", account: "org-acct" });
		expect(shapeCredentials(SNOWFLAKE, "tok", config)).toMatchObject({
			type: "apikey",
			baseUrl: "https://h.snowflakecomputing.com/api/v2/cortex/v1",
		});
	});

	it("falls back to account when only account is present", () => {
		const config = fakeConfig({ account: "org-acct" });
		expect(shapeCredentials(SNOWFLAKE, "tok", config)).toMatchObject({
			baseUrl: "https://org-acct.snowflakecomputing.com/api/v2/cortex/v1",
		});
	});

	it("leaves the URL undefined when neither host nor account is present", () => {
		expect(shapeCredentials(SNOWFLAKE, "tok", fakeConfig())).toMatchObject({
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
			shapeCredentials(AWS, awsToken, config({ getAws: () => ({ region: "eu-west-1" }) })),
		).toEqual({
			type: "aws-credentials",
			region: "eu-west-1",
			accessKeyId: "AKIA",
			secretAccessKey: "secret",
			sessionToken: "sess",
		});
	});

	it("defaults the region to us-east-1 when none is configured", () => {
		expect(shapeCredentials(AWS, awsToken, config())).toMatchObject({ region: "us-east-1" });
	});

	it("returns null for a non-JSON token", () => {
		expect(shapeCredentials(AWS, "not-json", config())).toBeNull();
	});

	it("returns null when accessKeyId or secretAccessKey is missing", () => {
		expect(shapeCredentials(AWS, JSON.stringify({ accessKeyId: "AKIA" }), config())).toBeNull();
	});

	it("includes the configured profile", () => {
		const cfg = config({ getAws: () => ({ region: "eu-west-1", profile: "work" }) });
		expect(shapeCredentials(AWS, awsToken, cfg)).toMatchObject({
			type: "aws-credentials",
			region: "eu-west-1",
			profile: "work",
		});
	});
});

describe("shapeCredentials — Google Cloud credentials JSON", () => {
	it("parses project/location/token for a brokered token", () => {
		const token = JSON.stringify({ project: "p", location: "us-central1", token: "gcp-tok" });
		expect(shapeCredentials(GOOGLE, token, config())).toEqual({
			type: "google-cloud",
			project: "p",
			location: "us-central1",
			accessToken: "gcp-tok",
		});
	});

	it("omits accessToken for the ADC fallback when no token is present", () => {
		const token = JSON.stringify({ project: "p", location: "us-central1" });
		expect(shapeCredentials(GOOGLE, token, config())).toEqual({
			type: "google-cloud",
			project: "p",
			location: "us-central1",
		});
	});

	it("returns null for a non-JSON token", () => {
		expect(shapeCredentials(GOOGLE, "not-json", config())).toBeNull();
	});

	it("returns null when project or location is missing", () => {
		expect(shapeCredentials(GOOGLE, JSON.stringify({ project: "p" }), config())).toBeNull();
		expect(shapeCredentials(GOOGLE, JSON.stringify({ location: "l" }), config())).toBeNull();
	});
});

describe("shapeCredentials — apikey baseUrl + customHeaders", () => {
	it("reads baseUrl and customHeaders under the provider configKey", () => {
		const cfg = config({
			getBaseUrl: (k) => (k === "anthropic" ? "https://proxy" : undefined),
			getCustomHeaders: (k) => (k === "anthropic" ? { "x-tenancy": "t" } : undefined),
		});
		expect(shapeCredentials(ANTHROPIC, "sk", cfg)).toEqual({
			type: "apikey",
			apiKey: "sk",
			baseUrl: "https://proxy",
			customHeaders: { "x-tenancy": "t" },
		});
	});

	it("normalizes an empty customHeaders object to undefined", () => {
		expect(
			shapeCredentials(ANTHROPIC, "sk", config({ getCustomHeaders: () => ({}) })),
		).toMatchObject({ customHeaders: undefined });
	});

	it("uses the authProviderId as configKey when no override exists (openai-api)", () => {
		const cfg = config({
			getCustomHeaders: (k) => (k === "openai-api" ? { "x-flag": "1" } : undefined),
		});
		expect(shapeCredentials(OPENAI, "sk", cfg)).toMatchObject({
			customHeaders: { "x-flag": "1" },
		});
	});
});
