/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the pure credential shaper. No vscode -- the config reads are a
 * plain fake. The auth-host-bound half (session lookup) is covered by auth.test.ts,
 * which exercises this function end-to-end through getMappedCredentials.
 */

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

import { describe, expect, it } from "vitest";

import { type CredentialConfig, shapeCredentials } from "../credential-shaping";

const HERE = dirname(fileURLToPath(import.meta.url));

function fakeConfig(
	overrides: {
		baseUrls?: Record<string, string>;
		customHeaders?: Record<string, Record<string, string>>;
		awsRegion?: string;
		awsProfile?: string;
		snowflake?: { host?: string; account?: string };
	} = {},
): CredentialConfig {
	return {
		getBaseUrl: (configKey) => overrides.baseUrls?.[configKey],
		getCustomHeaders: (configKey) => overrides.customHeaders?.[configKey],
		getAwsRegion: () => overrides.awsRegion,
		getAwsProfile: () => overrides.awsProfile,
		getSnowflake: () => overrides.snowflake,
	};
}

const APIKEY = { authProviderId: "openai-api", credentialType: "apikey" } as const;
const ANTHROPIC = { authProviderId: "anthropic-api", credentialType: "apikey" } as const;
const OAUTH = { authProviderId: "posit-ai", credentialType: "oauth" } as const;
const AWS = { authProviderId: "amazon-bedrock", credentialType: "aws-credentials" } as const;
const GCP = { authProviderId: "google-cloud", credentialType: "google-cloud" } as const;
const SNOWFLAKE = { authProviderId: "snowflake-cortex", credentialType: "apikey" } as const;

describe("shapeCredentials", () => {
	// --- oauth ---

	it("shapes an oauth token", () => {
		expect(shapeCredentials(OAUTH, "bearer-123", fakeConfig())).toEqual({
			type: "oauth",
			accessToken: "bearer-123",
		});
	});

	// --- apikey ---

	it("shapes an apikey with no baseUrl/customHeaders", () => {
		expect(shapeCredentials(APIKEY, "sk-openai", fakeConfig())).toEqual({
			type: "apikey",
			apiKey: "sk-openai",
			baseUrl: undefined,
			customHeaders: undefined,
		});
	});

	it("reads baseUrl under the overridden config key (anthropic-api -> anthropic)", () => {
		const config = fakeConfig({ baseUrls: { anthropic: "https://custom.anthropic.example/v1" } });
		expect(shapeCredentials(ANTHROPIC, "sk-ant", config)).toEqual({
			type: "apikey",
			apiKey: "sk-ant",
			baseUrl: "https://custom.anthropic.example/v1",
			customHeaders: undefined,
		});
	});

	it("normalizes an empty-string baseUrl from the config to undefined", () => {
		const config = fakeConfig({ baseUrls: { anthropic: "" } });
		expect(shapeCredentials(ANTHROPIC, "sk-ant", config)).toMatchObject({
			baseUrl: undefined,
		});
	});

	it("reads customHeaders under the config key and normalizes empty to undefined", () => {
		const withHeaders = fakeConfig({ customHeaders: { anthropic: { "x-tenancy": "team-42" } } });
		expect(shapeCredentials(ANTHROPIC, "sk-ant", withHeaders)).toMatchObject({
			customHeaders: { "x-tenancy": "team-42" },
		});

		const emptyHeaders = fakeConfig({ customHeaders: { anthropic: {} } });
		expect(shapeCredentials(ANTHROPIC, "sk-ant", emptyHeaders)).toMatchObject({
			customHeaders: undefined,
		});
	});

	// --- snowflake (apikey with a built base URL) ---

	it("builds the snowflake URL from host, preferring it over account", () => {
		const config = fakeConfig({
			snowflake: { host: "h.snowflakecomputing.com", account: "org-acct" },
		});
		expect(shapeCredentials(SNOWFLAKE, "tok", config)).toMatchObject({
			baseUrl: "https://h.snowflakecomputing.com/api/v2/cortex/v1",
		});
	});

	it("builds the snowflake URL from account when no host, and undefined when neither", () => {
		const fromAccount = fakeConfig({ snowflake: { account: "org-acct" } });
		expect(shapeCredentials(SNOWFLAKE, "tok", fromAccount)).toMatchObject({
			baseUrl: "https://org-acct.snowflakecomputing.com/api/v2/cortex/v1",
		});

		expect(shapeCredentials(SNOWFLAKE, "tok", fakeConfig())).toMatchObject({
			baseUrl: undefined,
		});
	});

	// --- aws-credentials ---

	it("shapes aws credentials, taking region from config", () => {
		const token = JSON.stringify({
			accessKeyId: "AKIA",
			secretAccessKey: "secret",
			sessionToken: "sess",
		});
		const config = fakeConfig({ awsRegion: "us-west-2" });
		expect(shapeCredentials(AWS, token, config)).toEqual({
			type: "aws-credentials",
			region: "us-west-2",
			accessKeyId: "AKIA",
			secretAccessKey: "secret",
			sessionToken: "sess",
		});
	});

	it("defaults the aws region to us-east-1 when config has none", () => {
		const token = JSON.stringify({ accessKeyId: "AKIA", secretAccessKey: "secret" });
		expect(shapeCredentials(AWS, token, fakeConfig())).toMatchObject({
			region: "us-east-1",
		});
	});

	it("returns null for aws when the token is not JSON or lacks required fields", () => {
		expect(shapeCredentials(AWS, "not-json", fakeConfig())).toBeNull();
		expect(shapeCredentials(AWS, JSON.stringify({ accessKeyId: "AKIA" }), fakeConfig())).toBeNull();
	});

	// --- google-cloud ---

	it("shapes google-cloud with a brokered token, and without one for ADC", () => {
		const withToken = JSON.stringify({ token: "t", project: "p", location: "us-central1" });
		expect(shapeCredentials(GCP, withToken, fakeConfig())).toEqual({
			type: "google-cloud",
			project: "p",
			location: "us-central1",
			accessToken: "t",
		});

		const noToken = JSON.stringify({ project: "p", location: "us-central1" });
		expect(shapeCredentials(GCP, noToken, fakeConfig())).toEqual({
			type: "google-cloud",
			project: "p",
			location: "us-central1",
		});
	});

	it("returns null for google-cloud when the token is not JSON or lacks project/location", () => {
		expect(shapeCredentials(GCP, "not-json", fakeConfig())).toBeNull();
		expect(
			shapeCredentials(GCP, JSON.stringify({ token: "t", location: "us-central1" }), fakeConfig()),
		).toBeNull();
		expect(
			shapeCredentials(GCP, JSON.stringify({ token: "t", project: "p" }), fakeConfig()),
		).toBeNull();
	});
});

describe("credential-shaping stays browser-safe", () => {
	// The bridge's credential-shaping.ts is now a thin re-export shim that
	// delegates to ai-credentials/types. The real purity invariant lives in
	// ai-credentials; we guard both files here.

	it("bridge shim only re-exports from ai-credentials/types", () => {
		const source = readFileSync(resolve(HERE, "../credential-shaping.ts"), "utf-8");
		const valueImports = [
			...source.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+"([^"]+)";/gm),
			...source.matchAll(/^import\s+"([^"]+)";/gm),
		].map((m) => m[1]);
		expect(valueImports).toEqual(["ai-credentials/types"]);
		expect(source).not.toMatch(/\bimport\s*\(/);
	});

	it("ai-credentials/types/credential-shaping.ts has only local relative imports", () => {
		// The actual implementation must carry no vscode, AI-SDK, or Node-builtin
		// dependency. Its only runtime imports should be sibling modules within
		// the types/ directory (local relative paths starting with "./").
		const credentialsTypesDir = resolve(HERE, "../../../ai-credentials/src/types");
		const source = readFileSync(resolve(credentialsTypesDir, "credential-shaping.ts"), "utf-8");
		const valueImports = [
			...source.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+"([^"]+)";/gm),
			...source.matchAll(/^import\s+"([^"]+)";/gm),
		].map((m) => m[1]);

		// All runtime imports must be local relative paths
		for (const imp of valueImports) {
			expect(imp).toMatch(/^\.\//);
		}
		// Specifically: it imports the URL helper from ./utils
		expect(valueImports).toEqual(["./utils"]);
		// No dynamic imports
		expect(source).not.toMatch(/\bimport\s*\(/);
	});
});
