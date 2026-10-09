/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

export interface AwsCredentialSource {
	region: string;
	profile?: string;
	accessKeyId?: string;
	secretAccessKey?: string;
	sessionToken?: string;
}

export interface ResolvedAwsCredentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

type ManualAwsCredentialSource = AwsCredentialSource & {
	accessKeyId: string;
	secretAccessKey: string;
};

export function hasManualAwsKeys(
	credentials: AwsCredentialSource,
): credentials is ManualAwsCredentialSource {
	return Boolean(credentials.accessKeyId && credentials.secretAccessKey);
}

/**
 * Build the single credential-provider seam shared by every Bedrock route.
 * Both manual keys and the standard Node chain return the same provider shape.
 *
 * When `AWS_WEB_IDENTITY_TOKEN_FILE` is set, the chain's STS token exchange is
 * pointed at the configured region via `clientConfig`; otherwise the region is
 * omitted so an SSO profile's own `sso_region` applies.
 */
export function createAwsCredentialProvider(
	credentials: AwsCredentialSource,
	env: Readonly<Record<string, string | undefined>> = process.env,
): () => Promise<ResolvedAwsCredentials> {
	if (hasManualAwsKeys(credentials)) {
		return async () => ({
			accessKeyId: credentials.accessKeyId,
			secretAccessKey: credentials.secretAccessKey,
			...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
		});
	}

	return fromNodeProviderChain({
		profile: credentials.profile,
		...(env.AWS_WEB_IDENTITY_TOKEN_FILE ? { clientConfig: { region: credentials.region } } : {}),
	});
}
