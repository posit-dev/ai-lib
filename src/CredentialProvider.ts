/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ProviderId, ProviderCredentials } from "./types";

/**
 * Disposable handle returned by event subscriptions.
 */
export interface Disposable {
	dispose(): void;
}

/**
 * Platform-agnostic credential provider interface.
 *
 * Scoped to what the Positron direct path needs today:
 * - getCredentials: retrieve credentials for a specific provider
 * - onDidChangeCredentials: subscribe to credential changes
 *
 * The Node path (NodeModelService) owns richer credential-resolution logic
 * (auth-status checks, defaults/env fallback, Posit AI fetch metadata) and
 * uses provider-bridge's ProviderRegistry and client factories directly
 * without going through CredentialProvider.
 */
export interface CredentialProvider {
	getCredentials(providerId: ProviderId): Promise<ProviderCredentials | null>;
	onDidChangeCredentials(callback: (providerIds: ProviderId[]) => void): Disposable;
}
