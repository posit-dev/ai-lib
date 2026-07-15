/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025-2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider URL construction helpers (Snowflake Cortex, Databricks).
 *
 * Pure functions with no platform dependencies — safe for browser/renderer.
 */

// ---------------------------------------------------------------------------
// Snowflake
// ---------------------------------------------------------------------------

/**
 * Construct the Snowflake Cortex REST API base URL from a full hostname
 * (e.g., a private-link or RCR host).
 *
 * @param host - Snowflake hostname (e.g., "myorg-myaccount.snowflakecomputing.com")
 * @returns Full Cortex REST API base URL
 */
export function buildSnowflakeCortexUrlFromHost(host: string): string {
	return `https://${host}/api/v2/cortex/v1`;
}

/**
 * Construct the Snowflake Cortex REST API base URL from an account identifier.
 *
 * @param account - Snowflake account identifier (e.g., "myorg-myaccount")
 * @returns Full Cortex REST API base URL
 */
export function buildSnowflakeCortexUrl(account: string): string {
	return buildSnowflakeCortexUrlFromHost(`${account}.snowflakecomputing.com`);
}

// ---------------------------------------------------------------------------
// Databricks
// ---------------------------------------------------------------------------

/**
 * Normalize a Databricks workspace host to a bare `https://` origin.
 *
 * Accepts values with or without a scheme and with trailing slashes
 * (users paste hosts in all of these shapes from the Databricks UI).
 *
 * @param raw - Workspace host (e.g. "adb-123.4.azuredatabricks.net/")
 * @returns Normalized host (e.g. "https://adb-123.4.azuredatabricks.net")
 */
export function normalizeDatabricksHost(raw: string): string {
	let host = raw.trim().replace(/\/+$/, "");
	if (host && !/^https?:\/\//i.test(host)) {
		host = `https://${host}`;
	}
	return host;
}
