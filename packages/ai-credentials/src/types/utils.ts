/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025-2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Snowflake Cortex URL construction helpers.
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
