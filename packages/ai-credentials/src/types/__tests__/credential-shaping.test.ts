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

function fakeConfig(snowflake?: { host?: string; account?: string }): CredentialConfig {
	return {
		getBaseUrl: () => undefined,
		getCustomHeaders: () => undefined,
		getAwsRegion: () => undefined,
		getSnowflake: () => snowflake,
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
