/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ProviderCredentials } from "./types/credentials";

/**
 * Disposable handle returned by event subscriptions.
 */
export interface Disposable {
	dispose(): void;
}

/**
 * Platform-agnostic credential provider interface.
 *
 * The contract for retrieving provider credentials and subscribing to
 * credential changes. Host applications inject a concrete backend
 * (vscode.authentication in Positron, store + env outside).
 *
 * Provider IDs are accepted as plain strings so that custom catalog providers
 * (branded `CustomProviderId` from ai-config) are first-class without requiring
 * an import edge from ai-credentials to ai-config.
 */
export interface CredentialProvider {
	getCredentials(providerId: string): Promise<ProviderCredentials | null>;
	onDidChangeCredentials(callback: (providerIds: string[]) => void): Disposable;
}
