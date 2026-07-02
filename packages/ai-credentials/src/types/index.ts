/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * ai-credentials/types — Browser-safe credential types and shaping.
 *
 * This entrypoint exports credential interfaces, the shapeCredentials function,
 * and pure utility helpers. It has NO imports from: vscode, @ai-sdk/*, @aws-sdk/*,
 * ai, Node builtins (fs, path, os, crypto), @assistant/*, ai-config, or sibling
 * entrypoints (../store/). Only local relative imports.
 */

export type {
	ApiKeyCredentials,
	AwsCredentials,
	GoogleCloudCredentials,
	LocalCredentials,
	OAuthCredentials,
	ProviderCredentials,
} from "./credentials";

export { CONFIG_KEY_OVERRIDES, shapeCredentials } from "./credential-shaping";
export type { AuthProviderMapping, CredentialConfig } from "./credential-shaping";

export type { Logger } from "./logger";

export { buildSnowflakeCortexUrl, buildSnowflakeCortexUrlFromHost } from "./utils";
