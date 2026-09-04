/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Backend — the host-selected credential material seam.
 *
 * A `Backend` is injected into {@link createCredentialProvider}. It owns the
 * *material* (credentials read from a store + env, or from vscode.authentication)
 * and, for OAuth providers, the OAuth *config* + token *persistence*.
 * The root credential provider owns the provider-agnostic acquisition state
 * machine and calls the backend's {@link AcquisitionBackendHooks}; it never
 * learns the on-disk shape.
 *
 * Two concrete backends ship with ai-credentials:
 * - `ai-credentials/store-backend` — reads the generic store + env fallback and
 *   supplies OAuth hooks (device-flow providers persist tokens to disk).
 * - `ai-credentials/positron` — wraps vscode.authentication; it has **no** OAuth
 *   hooks because Positron's auth extension owns the sign-in flow, so OAuth
 *   providers resolve through {@link Backend.getCredentials}.
 */

import type {
	CredentialMutation,
	CredentialSourceInput,
	CredentialStatus,
	Disposable,
} from "./CredentialProvider.js";
import type { ProviderCredentials, TokenData } from "./types/index.js";

/**
 * OAuth connection config for a device-flow provider.
 *
 * Supplied by the backend (from resolved catalog connection config) so the
 * root state machine can hit the authorization/token endpoints without knowing
 * where the config came from.
 */
export interface OAuthProviderConfig {
	/** OAuth host, e.g. `login.posit.cloud` (no scheme). */
	authHost: string;
	/** OAuth scope, e.g. `prism`. */
	scope: string;
	/** OAuth client id, e.g. `databot`. */
	clientId: string;
}

export interface AuthorizationCodeCallback {
	code?: string;
	error?: string;
	errorDescription?: string;
}

export interface PreparedAuthorizationCodeReceiver {
	redirectUri: string;
	waitForCallback(): Promise<AuthorizationCodeCallback>;
	dispose(): void;
}

/** Host adapter for a loopback callback (or an in-memory test receiver). */
export interface AuthorizationCodeReceiver {
	prepare(input: {
		attemptId: string;
		state: string;
		timeoutMs: number;
	}): Promise<PreparedAuthorizationCodeReceiver>;
}

/** Provider-neutral OAuth grant configuration consumed by the acquisition engine. */
export type OAuthGrantConfig =
	| {
			grantType: "device-code";
			credentialBaseUrl?: string;
			clientId: string;
			scope: string;
			deviceAuthorizationEndpoint: string;
			tokenEndpoint: string;
	  }
	| {
			grantType: "authorization-code";
			credentialBaseUrl?: string;
			clientId: string;
			scope: string;
			authorizationEndpoint: string;
			tokenEndpoint: string;
			receiver: AuthorizationCodeReceiver;
			timeoutMs?: number;
			challengeExpiresIn?: number;
	  }
	| {
			grantType: "client-credentials";
			credentialBaseUrl?: string;
			clientId: string;
			clientSecret: string;
			scope?: string;
			tokenEndpoint: string;
			/** Non-secret identity used for process-memory token caching. */
			cacheKey: string;
	  };

export type CredentialSourceContext =
	| { type: "oauth-device"; origin: "stored" | "implicit" }
	| { type: "oauth-u2m"; origin: "stored"; workspaceHost: string }
	| {
			type: "oauth-m2m";
			origin: "stored" | "environment";
			workspaceHost: string;
			clientId: string;
			clientSecret: string;
	  };

/**
 * Currently-stored OAuth tokens for a provider, as read back by the backend.
 *
 * `expiresAt` is an ISO-8601 timestamp; the backend computes it from the
 * `expiresIn` seconds it receives when fresh tokens are persisted.
 */
export interface StoredOAuthTokens {
	accessToken: string;
	refreshToken: string;
	/** ISO-8601 expiry timestamp. */
	expiresAt: string;
	scope: string;
	tokenType: string;
}

export type AuthenticationCommitResult = "committed" | "superseded";

/** Durable hooks used by the generalized acquisition engine. */
export interface AcquisitionBackendHooks {
	configForProvider(providerId: string): Promise<OAuthGrantConfig | undefined>;
	readTokens(providerId: string): Promise<StoredOAuthTokens | null>;
	beginAuthentication(providerId: string): Promise<string>;
	commitAuthentication(
		providerId: string,
		generation: string,
		tokens: TokenData,
	): Promise<AuthenticationCommitResult>;
	finishAuthentication(
		providerId: string,
		generation: string,
		error: string,
	): Promise<AuthenticationCommitResult>;
	persistRefreshedTokens(providerId: string, tokens: TokenData): Promise<void>;
	persistRefreshError(providerId: string, error: string): Promise<void>;
	withRefreshTransaction<T>(providerId: string, operation: () => Promise<T>): Promise<T>;
	shapeToken(
		providerId: string,
		accessToken: string,
		config: OAuthGrantConfig,
	): ProviderCredentials;
	notifyReady(providerId: string): void;
}

/**
 * The host-selected credential material seam. See the file header.
 */
export interface Backend {
	/**
	 * Resolve runtime credential material for a provider, or null if none is
	 * available. For OAuth providers on backends that expose
	 * {@link Backend.acquisition}, the root routes through the acquisition
	 * engine instead of calling this — so store backends may return null for
	 * OAuth here.
	 */
	getCredentials(providerId: string): Promise<ProviderCredentials | null>;

	/** Subscribe to credential changes for the given provider ids. */
	onDidChangeCredentials(callback: (providerIds: string[]) => void): Disposable;

	/**
	 * OAuth acquisition hooks; absent when the backend has no OAuth acquisition
	 * (e.g. Positron, where the host owns the sign-in flow).
	 */
	acquisition?: AcquisitionBackendHooks;
}

export interface MutableBackend extends Backend {
	mutateCredentials(providerId: string, mutation: CredentialMutation): Promise<void>;
	getCredentialStatus(providerId: string): Promise<CredentialStatus>;
	/** Resolve the active source without exposing its disk representation. */
	getCredentialSource(providerId: string): Promise<CredentialSourceInput | null>;
}
