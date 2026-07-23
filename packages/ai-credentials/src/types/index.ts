/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * ai-credentials/types — Browser-safe credential types and shaping.
 *
 * This entrypoint exports credential interfaces, the shapeCredentials function,
 * OAuth protocol types, custom-provider auth descriptors, storage-key helpers,
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
} from "./credentials.js";

export { CONFIG_KEY_OVERRIDES, shapeCredentials } from "./credential-shaping.js";
export type { AuthProviderMapping, CredentialConfig } from "./credential-shaping.js";

export type { Logger } from "./logger.js";

export {
	buildSnowflakeCortexUrl,
	buildSnowflakeCortexUrlFromHost,
	normalizeDatabricksHost,
} from "./utils.js";

// OAuth protocol/runtime types (moved from @assistant/core platform.ts)
export type { DeviceAuthInfo, TokenData } from "./oauth-types.js";

// Storage-key scheme
export { storageKeyFor } from "./storage-key.js";

// Custom-provider auth descriptors (moved from node's ProviderCatalogService)
export {
	CUSTOM_CLIENT_KIND_AUTH_MAP,
	SUPPORTED_CUSTOM_CLIENT_KIND_VALUES,
	SUPPORTED_CUSTOM_CLIENT_KINDS,
} from "./auth-descriptors.js";
export type { CustomAuthMapping } from "./auth-descriptors.js";
