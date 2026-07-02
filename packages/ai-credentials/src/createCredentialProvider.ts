/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * createCredentialProvider — the deep resolver seam over a host-selected backend.
 *
 * Wraps any {@link Backend} into the full {@link CredentialProvider} resolver
 * surface. The root owns the device-flow/refresh state machine ({@link OAuthEngine});
 * the backend supplies material, OAuth config, and token persistence.
 *
 * Routing:
 * - `getCredentials`: OAuth providers (backend exposes `oauth` config for the id)
 *   route through `getAccessToken` and wrap the token; everything else defers to
 *   `backend.getCredentials`.
 * - `getAccessToken` / `startDeviceAuth`: delegate to the engine, which returns
 *   null / throws for providers with no device-flow config.
 */

import type { Backend } from "./Backend";
import type { CredentialProvider, Disposable } from "./CredentialProvider";
import { OAuthEngine } from "./device-auth";
import type { DeviceAuthInfo, Logger, ProviderCredentials } from "./types";

export interface CreateCredentialProviderOptions {
	/** Host-selected backend (store+env outside Positron, vscode inside). */
	backend: Backend;
	/** Optional logger for the device-flow/refresh state machine. */
	logger?: Logger;
}

/**
 * A {@link CredentialProvider} that additionally exposes lifecycle disposal so
 * hosts can cancel in-flight device-flow polling on shutdown.
 */
export interface CredentialProviderHandle extends CredentialProvider {
	dispose(): void;
}

/** Build a {@link CredentialProvider} over the given backend. */
export function createCredentialProvider(
	options: CreateCredentialProviderOptions,
): CredentialProviderHandle {
	const { backend, logger } = options;
	const engine = backend.oauth ? new OAuthEngine(backend.oauth, logger) : undefined;

	async function getAccessToken(providerId: string): Promise<string | null> {
		if (!engine) return null;
		return engine.getAccessToken(providerId);
	}

	async function getCredentials(providerId: string): Promise<ProviderCredentials | null> {
		// Device-flow OAuth providers (backend exposes config) resolve through the
		// engine so refresh is handled. Non-OAuth (and OAuth-via-vscode) defer to
		// the backend.
		if (backend.oauth?.configForProvider(providerId)) {
			const accessToken = await getAccessToken(providerId);
			return accessToken ? { type: "oauth", accessToken } : null;
		}
		return backend.getCredentials(providerId);
	}

	function startDeviceAuth(providerId: string): Promise<DeviceAuthInfo> {
		if (!engine) {
			return Promise.reject(
				new Error(`OAuth device auth not supported for provider: ${providerId}`),
			);
		}
		return engine.startDeviceAuth(providerId);
	}

	function onDidChangeCredentials(callback: (providerIds: string[]) => void): Disposable {
		return backend.onDidChangeCredentials(callback);
	}

	function dispose(): void {
		engine?.dispose();
	}

	return { getCredentials, getAccessToken, startDeviceAuth, onDidChangeCredentials, dispose };
}
