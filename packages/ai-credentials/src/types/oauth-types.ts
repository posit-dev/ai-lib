/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * OAuth protocol/runtime types.
 *
 * These are pure interfaces with no runtime, no platform dependencies. They
 * define the shapes returned by the OAuth device authorization flow (RFC 8628)
 * and the token endpoint.
 *
 * Moved here from @assistant/core's platform.ts so that ai-credentials' resolver
 * surface can reference them without importing @assistant/core. Core re-exports
 * them from platform.ts for backward compatibility.
 */

/**
 * Information returned when starting OAuth device authorization flow.
 */
export interface DeviceAuthInfo {
	/** Code to display to the user */
	userCode: string;
	/** URL to open in browser for user to authorize */
	verificationUri: string;
	/** Complete URL with user code pre-filled */
	verificationUriComplete: string;
	/** Device code for polling token endpoint */
	deviceCode: string;
	/** Polling interval in seconds */
	interval: number;
	/** Expiration time in seconds */
	expiresIn: number;
}

/**
 * OAuth token data returned by the token endpoint.
 */
export interface TokenData {
	accessToken: string;
	refreshToken: string;
	expiresIn: number; // seconds
	tokenType: string;
	scope: string;
}
