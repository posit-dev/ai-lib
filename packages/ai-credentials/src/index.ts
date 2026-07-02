/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * ai-credentials — root entrypoint.
 *
 * Exports the platform-agnostic CredentialProvider interface and Disposable.
 * The full factory (`createCredentialProvider({ backend })`) and Backend
 * interface land in Phase 4.
 */

export type { CredentialProvider, Disposable } from "./CredentialProvider";
