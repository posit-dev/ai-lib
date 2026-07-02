/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Backend — the host-selected credential material seam.
 *
 * A `Backend` is injected into {@link createCredentialProvider}. It owns the
 * *material* (credentials read from a store + env, or from vscode.authentication)
 * and, for OAuth device-flow providers, the OAuth *config* + token *persistence*.
 * The root credential provider owns the provider-agnostic device-flow/refresh
 * state machine (RFC 8628) and calls the backend's {@link OAuthBackendHooks};
 * it never learns the on-disk shape.
 *
 * Two concrete backends ship with ai-credentials:
 * - `ai-credentials/store-backend` — reads the generic store + env fallback and
 *   supplies OAuth hooks (device-flow providers persist tokens to disk).
 * - `ai-credentials/positron` — wraps vscode.authentication; it has **no** OAuth
 *   hooks because Positron's auth extension owns the sign-in flow, so OAuth
 *   providers resolve through {@link Backend.getCredentials}.
 */

import type { Disposable } from "./CredentialProvider";
import type { ProviderCredentials, TokenData } from "./types";

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

/**
 * Currently-stored OAuth tokens for a provider, as read back by the backend.
 *
 * `expiresAt` is an ISO-8601 timestamp; the backend computes it from the
 * `expiresIn` seconds it receives via {@link OAuthBackendHooks.persistTokens}.
 */
export interface StoredOAuthTokens {
	accessToken: string;
	refreshToken: string;
	/** ISO-8601 expiry timestamp. */
	expiresAt: string;
	scope: string;
	tokenType: string;
}

/**
 * OAuth device-flow hooks (option B).
 *
 * Present only on backends that support the device-authorization flow (the
 * store backend). The root state machine calls these to read/persist tokens
 * and errors; the backend owns the disk shape and the storage key.
 */
export interface OAuthBackendHooks {
	/**
	 * OAuth config for a provider, or `undefined` if the provider has no
	 * device-flow support in this host. `undefined` signals the root to treat
	 * the provider as non-OAuth (returns null from getAccessToken; throws from
	 * startDeviceAuth).
	 */
	configForProvider(providerId: string): OAuthProviderConfig | undefined;

	/** Read the currently-stored tokens for a provider (null if none/invalid). */
	readTokens(providerId: string): Promise<StoredOAuthTokens | null>;

	/**
	 * Persist freshly-minted tokens. The backend computes and stores the
	 * absolute expiry from `tokens.expiresIn`.
	 */
	persistTokens(providerId: string, tokens: TokenData): Promise<void>;

	/** Persist an auth error (clears authenticated state) for a provider. */
	persistError(providerId: string, error: string): Promise<void>;

	/**
	 * Notify the host that a provider's credentials are ready/refreshed. Used to
	 * trigger model-cache refresh + UI updates. Fire-and-forget.
	 */
	notifyReady(providerId: string): void;
}

/**
 * The host-selected credential material seam. See the file header.
 */
export interface Backend {
	/**
	 * Resolve runtime credential material for a provider, or null if none is
	 * available. For device-flow OAuth providers on backends that expose
	 * {@link Backend.oauth}, the root routes through the OAuth state machine
	 * instead of calling this — so store backends may return null for OAuth here.
	 */
	getCredentials(providerId: string): Promise<ProviderCredentials | null>;

	/** Subscribe to credential changes for the given provider ids. */
	onDidChangeCredentials(callback: (providerIds: string[]) => void): Disposable;

	/** OAuth device-flow hooks; absent when the backend has no device flow. */
	oauth?: OAuthBackendHooks;
}
