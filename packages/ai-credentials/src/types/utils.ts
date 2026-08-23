/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025-2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider URL construction helpers (Snowflake Cortex, Databricks, OAuth hosts).
 *
 * Pure functions with no platform dependencies — safe for browser/renderer.
 */

// ---------------------------------------------------------------------------
// OAuth auth hosts
// ---------------------------------------------------------------------------

/**
 * Validate a user-supplied OAuth auth host, returning it unchanged when it is
 * a bare authority (`host[:port]`) suitable for interpolating into
 * `https://${host}/oauth/...` endpoint URLs.
 *
 * Users naturally paste a host with a scheme (`https://login.posit.cloud`)
 * because every other URL-shaped setting takes one; without validation the
 * interpolation produces `https://https://login.posit.cloud/...`, which the
 * fetch stack parses with `https` as the hostname and fails with the cryptic
 * `getaddrinfo ENOTFOUND https`. Throw a descriptive error instead, so the
 * message that reaches the UI says exactly what to fix.
 */
export function requireBareAuthHost(raw: string): string {
	const host = raw.trim();
	const invalid = (): never => {
		throw new Error(
			`Invalid auth host "${raw}": expected a bare hostname such as "login.posit.cloud" — remove the URL scheme and any path.`,
		);
	};
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(host) || /[/?#\\\s]/.test(host)) {
		invalid();
	}
	// Round-trip through URL parsing so anything that isn't a bare authority
	// (empty values, userinfo such as "user@host", invalid ports) is rejected
	// here rather than failing later with a cryptic URL/fetch error — or, in
	// the userinfo case, silently targeting a different hostname.
	let parsedHost: string | undefined;
	try {
		const url = new URL(`https://${host}`);
		if (!url.username && !url.password) parsedHost = url.host;
	} catch {
		// Not parseable as an authority (empty value, invalid port, …).
	}
	if (!host || parsedHost?.toLowerCase() !== host.toLowerCase()) {
		invalid();
	}
	return host;
}

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
	let value = raw.trim();
	if (!value) throw new Error("Databricks workspace URL is required");
	if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) value = `https://${value}`;
	const url = new URL(value);
	if (url.protocol !== "https:") {
		throw new Error("Databricks workspace URL must use HTTPS");
	}
	if (url.username || url.password) {
		throw new Error("Databricks workspace URL cannot contain credentials");
	}
	return url.origin;
}
