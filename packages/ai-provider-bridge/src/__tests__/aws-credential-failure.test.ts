/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { classifyAwsCredentialFailure } from "../aws-credential-failure";

// Credential-provider messages as the AWS SDK words them.

/** `@aws-sdk/token-providers`: an expired SSO-session token. */
const SSO_TOKEN_EXPIRED =
	"Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile.";
/** `@aws-sdk/credential-provider-sso`: an expired legacy SSO profile. */
const LEGACY_SSO_EXPIRED =
	"The SSO session associated with this profile has expired. To refresh this SSO session run aws sso login with the corresponding profile.";
/** `@aws-sdk/credential-provider-process`: the helper returned an `Expiration` in the past. */
const PROCESS_EXPIRED = "Profile analytics credential_process returned expired credentials.";
/** `@aws-sdk/token-providers`: no usable cached SSO token (never signed in, or cache cleared). */
const SSO_NOT_SIGNED_IN =
	"The SSO session token associated with profile=analytics was not found or is invalid. To refresh this SSO session run 'aws sso login' with the corresponding profile.";
/** `@aws-sdk/credential-provider-sso`: a legacy SSO profile whose cached token is missing or unreadable. */
const LEGACY_SSO_INVALID =
	"The SSO session associated with this profile is invalid. To refresh this SSO session run aws sso login with the corresponding profile.";
/** `@aws-sdk/token-providers`: a cached SSO token missing a required field. */
const SSO_TOKEN_VALUE_MISSING =
	"Value not present for 'accessToken' in SSO Token. To refresh this SSO session run 'aws sso login' with the corresponding profile.";

/** The plain error text the Bedrock SDK throws when the credential provider fails. */
function wrapped(message: string): string {
	return `AWS credential provider failed: ${message}. Please ensure your credential provider returns valid AWS credentials with accessKeyId and secretAccessKey properties.`;
}

const fixtures: ReadonlyArray<[string, string, "expired" | "not-signed-in" | undefined]> = [
	["SSO token expired", SSO_TOKEN_EXPIRED, "expired"],
	["legacy SSO profile expired", LEGACY_SSO_EXPIRED, "expired"],
	["credential_process returned expired credentials", PROCESS_EXPIRED, "expired"],
	["SSO token not found", SSO_NOT_SIGNED_IN, "not-signed-in"],
	["legacy SSO profile invalid", LEGACY_SSO_INVALID, "not-signed-in"],
	["SSO token missing a value", SSO_TOKEN_VALUE_MISSING, "not-signed-in"],
	// Neither expiry nor a missing sign-in.
	["no credentials", "Could not load credentials from any providers", undefined],
	["missing profile", "Profile analytics was not found.", undefined],
	// credential-provider-process passes a failing helper's own output through.
	[
		"helper output: certificate has expired",
		"Command failed: corp-aws-helper --profile analytics\nerror: certificate has expired",
		undefined,
	],
	[
		"helper output: OAuth token is expired",
		"Command failed: corp-aws-helper --profile analytics\nerror: OAuth token is expired",
		undefined,
	],
	[
		"helper output: returned expired credentials",
		"Command failed: corp-aws-helper\nerror: upstream returned expired credentials",
		undefined,
	],
	["offline SSO refresh", "getaddrinfo ENOTFOUND oidc.us-east-1.amazonaws.com", undefined],
];

describe("classifyAwsCredentialFailure", () => {
	it.each(fixtures)("raw: %s", (_, message, expected) => {
		expect(classifyAwsCredentialFailure(message)).toBe(expected);
	});

	it.each(fixtures)("wrapped: %s", (_, message, expected) => {
		expect(classifyAwsCredentialFailure(wrapped(message))).toBe(expected);
	});
});
