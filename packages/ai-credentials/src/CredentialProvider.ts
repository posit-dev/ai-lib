/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { DeviceAuthInfo, ProviderCredentials } from "./types";

export type AuthenticationChallenge =
	| {
			kind: "device-code";
			attemptId: string;
			verificationUri: string;
			verificationUriComplete: string;
			userCode: string;
			expiresIn: number;
	  }
	| {
			kind: "authorization-code";
			attemptId: string;
			authorizationUrl: string;
			expiresIn: number;
	  };

export type AuthenticationStartResult =
	| { status: "started"; challenge: AuthenticationChallenge }
	| { status: "already-in-progress" };

/** Strict semantic inputs accepted by the store-backed credential controller. */
export type CredentialSourceInput =
	| { type: "api-key"; apiKey: string; baseUrl?: string }
	| { type: "oauth-device" }
	| { type: "oauth-u2m"; workspaceHost: string }
	| {
			type: "oauth-m2m";
			clientId: string;
			clientSecret: string;
			workspaceHost: string;
	  }
	| { type: "local"; endpoint: string }
	| {
			type: "aws-credentials";
			region: string;
			profile?: string;
			accessKeyId?: string;
			secretAccessKey?: string;
			sessionToken?: string;
	  }
	| { type: "google-cloud"; project: string; location: string };

export type CredentialMutation =
	| { kind: "replace"; source: CredentialSourceInput }
	| { kind: "clear" };

export interface CredentialStatus {
	configured: boolean;
	authenticated: boolean;
	readiness: "pending" | "ready" | "unauthenticated";
	source?: CredentialSourceInput["type"];
	origin?: "stored" | "environment";
	expiresAt?: string;
	scope?: string;
	error?: string;
	metadata?: Record<string, unknown>;
}

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

	/** Start an interactive authentication flow, if the provider supports one. */
	startAuthentication(providerId: string): Promise<AuthenticationStartResult>;

	/** Cancel one opaque authentication attempt. Unknown ids are ignored. */
	cancelAuthentication(attemptId: string): void;

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

/** Store-backed extension. Host-owned backends intentionally omit mutation. */
export interface MutableCredentialProvider extends CredentialProvider {
	mutateCredentials(providerId: string, mutation: CredentialMutation): Promise<void>;
	getCredentialStatus(providerId: string): Promise<CredentialStatus>;
}
