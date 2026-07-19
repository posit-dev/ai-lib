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

import { AcquisitionEngine } from "./acquisition";
import type { Backend, MutableBackend } from "./Backend";
import type {
	AuthenticationStartResult,
	CredentialMutation,
	CredentialProvider,
	CredentialStatus,
	Disposable,
	MutableCredentialProvider,
} from "./CredentialProvider";
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
	/**
	 * Cancel any in-flight device-authorization polling for a provider (e.g. on
	 * logout, so a pending sign-in can't complete after the user opted out).
	 * No-op when the backend has no device flow or no polling is active.
	 */
	cancelDeviceAuth(providerId: string): void;
	dispose(): Promise<void>;
}

export interface MutableCredentialProviderHandle
	extends CredentialProviderHandle, MutableCredentialProvider {}

export function createCredentialProvider(
	options: CreateCredentialProviderOptions & { backend: MutableBackend },
): MutableCredentialProviderHandle;
export function createCredentialProvider(
	options: CreateCredentialProviderOptions,
): CredentialProviderHandle;

/** Build a {@link CredentialProvider} over the given backend. */
export function createCredentialProvider(
	options: CreateCredentialProviderOptions,
): CredentialProviderHandle {
	const { backend, logger } = options;
	const engine = backend.oauth ? new OAuthEngine(backend.oauth, logger) : undefined;
	const acquisition = backend.acquisition
		? new AcquisitionEngine(backend.acquisition, logger)
		: undefined;

	async function getAccessToken(providerId: string): Promise<string | null> {
		if (acquisition) {
			const result = await acquisition.getCredentials(providerId);
			if (result.handled) {
				if (result.credentials?.type === "oauth") return result.credentials.accessToken;
				if (result.credentials?.type === "apikey") return result.credentials.apiKey;
				return null;
			}
		}
		if (!engine) return null;
		return engine.getAccessToken(providerId);
	}

	async function getCredentials(providerId: string): Promise<ProviderCredentials | null> {
		if (acquisition) {
			const result = await acquisition.getCredentials(providerId);
			if (result.handled) return result.credentials;
		}
		// Device-flow OAuth providers (backend exposes config) resolve through the
		// engine so refresh is handled. Non-OAuth (and OAuth-via-vscode) defer to
		// the backend.
		if (backend.oauth?.configForProvider(providerId)) {
			const accessToken = await getAccessToken(providerId);
			return accessToken ? { type: "oauth", accessToken } : null;
		}
		return backend.getCredentials(providerId);
	}

	function startAuthentication(providerId: string): Promise<AuthenticationStartResult> {
		if (acquisition) return acquisition.startAuthentication(providerId);
		return startDeviceAuth(providerId).then((info) => ({
			status: "started" as const,
			challenge: {
				kind: "device-code" as const,
				attemptId: providerId,
				verificationUri: info.verificationUri,
				verificationUriComplete: info.verificationUriComplete,
				userCode: info.userCode,
				expiresIn: info.expiresIn,
			},
		}));
	}

	function cancelAuthentication(attemptId: string): void {
		if (acquisition) {
			acquisition.cancelAuthentication(attemptId);
			return;
		}
		cancelDeviceAuth(attemptId);
	}

	function startDeviceAuth(providerId: string): Promise<DeviceAuthInfo> {
		if (acquisition) return acquisition.startDeviceAuthentication(providerId);
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

	function cancelDeviceAuth(providerId: string): void {
		if (acquisition) {
			acquisition.cancelProvider(providerId);
			return;
		}
		engine?.cancelPolling(providerId);
	}

	async function dispose(): Promise<void> {
		engine?.dispose();
		await acquisition?.dispose();
	}

	const result: CredentialProviderHandle = {
		getCredentials,
		startAuthentication,
		cancelAuthentication,
		getAccessToken,
		startDeviceAuth,
		onDidChangeCredentials,
		cancelDeviceAuth,
		dispose,
	};

	if (isMutableBackend(backend)) {
		const mutable = result as MutableCredentialProviderHandle;
		mutable.mutateCredentials = async (
			providerId: string,
			mutation: CredentialMutation,
		): Promise<void> => {
			acquisition?.cancelProvider(providerId, false);
			await backend.mutateCredentials(providerId, mutation);
		};
		mutable.getCredentialStatus = (providerId: string): Promise<CredentialStatus> =>
			backend.getCredentialStatus(providerId);
		return mutable;
	}

	return result;
}

function isMutableBackend(backend: Backend): backend is MutableBackend {
	return "mutateCredentials" in backend && "getCredentialStatus" in backend;
}
