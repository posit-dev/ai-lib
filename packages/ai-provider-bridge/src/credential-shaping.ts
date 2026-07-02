/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure, platform-neutral credential shaping.
 *
 * Implementation has moved to `ai-credentials/types`. This module re-exports
 * the public API unchanged so existing consumers (`ai-provider-bridge/credential-shaping`)
 * continue to work.
 */

export { CONFIG_KEY_OVERRIDES, shapeCredentials } from "ai-credentials/types";
export type { AuthProviderMapping, CredentialConfig } from "ai-credentials/types";
