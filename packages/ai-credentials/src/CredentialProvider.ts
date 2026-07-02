/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { DeviceAuthInfo, ProviderCredentials } from "./types";

/**
 * Disposable handle returned by event subscriptions.
 */
export interface Disposable {
	dispose(): void;
}

/**
 * Platform-agnostic credential resolver surface.
 *
 * The contract for retrieving provider credentials, driving the OAuth device
 * flow, and subscribing to credential changes. Produced by
 * {@link createCredentialProvider} over a host-selected {@link Backend}
 * (vscode.authentication in Positron, store + env outside).
 *
 * The device-flow/refresh state machine is owned here (root); the backend
 * supplies material, OAuth config, and token persistence.
 *
 * Provider IDs are accepted as plain strings so that custom catalog providers
 * (branded `CustomProviderId` from ai-config) are first-class without requiring
 * an import edge from ai-credentials to ai-config.
 */
export interface CredentialProvider {
	/**
	 * Resolve runtime credentials for a provider (OAuth providers auto-refresh
	 * via {@link CredentialProvider.getAccessToken}). Null if unavailable.
	 */
	getCredentials(providerId: string): Promise<ProviderCredentials | null>;

	/**
	 * Current OAuth access token for a provider, refreshing if it is expired or
	 * within the jittered refresh window. Null if the provider is not a
	 * device-flow OAuth provider or is not authenticated.
	 */
	getAccessToken(providerId: string): Promise<string | null>;

	/**
	 * Start the OAuth device-authorization flow for a provider. Returns the
	 * device-code info for display and polls for the token in the background.
	 * Throws if the provider does not support device auth.
	 */
	startDeviceAuth(providerId: string): Promise<DeviceAuthInfo>;

	/** Subscribe to credential changes for the given provider ids. */
	onDidChangeCredentials(callback: (providerIds: string[]) => void): Disposable;
}
