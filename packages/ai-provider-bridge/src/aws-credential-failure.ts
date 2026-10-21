/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Classification of AWS credential-provider failures. Pure (no AWS SDK import) so the root
 * entrypoint can export it to consumers that format errors without loading the SDK.
 */

/**
 * Expiry wording from the AWS credential providers, each anchored to the SDK's own surrounding
 * text so arbitrary helper output (e.g. "OAuth token is expired") doesn't match:
 * `Token is expired. To refresh this SSO session …` (token-providers, SSO sessions),
 * `The SSO session associated with this profile has expired.` (credential-provider-sso, legacy
 * profiles), `Profile … credential_process returned expired credentials.`
 * (credential-provider-process).
 */
const AWS_CREDENTIAL_EXPIRED =
	/\bToken is expired\. To refresh this SSO session\b|\bSSO session associated with this profile has expired\b|\bcredential_process returned expired credentials\b/i;

/**
 * Wording for no usable cached SSO token (the user never ran `aws sso login` for this profile, or
 * the cache was cleared or is damaged): `The SSO session token associated with profile=… was not
 * found or is invalid.` and `Value not present for '…' in SSO Token` (token-providers, SSO
 * sessions), `The SSO session associated with this profile is invalid.` (credential-provider-sso,
 * legacy profiles).
 */
const AWS_SSO_NOT_SIGNED_IN =
	/\bSSO session token associated with profile=.* was not found or is invalid\b|\bValue not present for '[^']*' in SSO Token\b|\bSSO session associated with this profile is invalid\b/i;

/**
 * Classify the error text from an AWS credential provider as an SSO sign-in problem that signing
 * in again fixes. Pass the provider's error message, raw or as wrapped by the Bedrock SDK's
 * `AWS credential provider failed:` prefix; the prefix doesn't affect the result. Matches only
 * known SDK wording, so arbitrary `credential_process` helper output (e.g. "certificate has
 * expired") and network failures stay unclassified. The caller must know the text came from a
 * credential provider: tools and other providers use some of the same words.
 */
export function classifyAwsCredentialFailure(
	text: string,
): "expired" | "not-signed-in" | undefined {
	if (AWS_SSO_NOT_SIGNED_IN.test(text)) return "not-signed-in";
	if (AWS_CREDENTIAL_EXPIRED.test(text)) return "expired";
	return undefined;
}
