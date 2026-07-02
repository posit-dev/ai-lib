/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * CredentialProvider interface — re-exported from ai-credentials.
 *
 * The canonical definition now lives in `ai-credentials` (root entrypoint).
 * This module re-exports the public API unchanged so existing consumers of
 * `ai-provider-bridge` keep compiling.
 */

export type { CredentialProvider, Disposable } from "ai-credentials";
