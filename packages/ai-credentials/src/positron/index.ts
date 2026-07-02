/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * ai-credentials/positron — vscode.authentication credential backend.
 *
 * Platform-bound entry (imports `vscode`). Never loaded outside Positron via
 * conditional exports, so the pure `/types` and root entries stay vscode-free.
 */

export { createPositronBackend, createVscodeCredentialConfig } from "./PositronBackend";
export type { CreatePositronBackendOptions, PositronBackend, ProviderMap } from "./PositronBackend";
