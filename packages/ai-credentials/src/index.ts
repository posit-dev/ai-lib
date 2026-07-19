/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * ai-credentials — root entrypoint.
 *
 * Exports the platform-agnostic credential resolver surface
 * ({@link CredentialProvider}), the injected {@link Backend} seam, and the
 * {@link createCredentialProvider} factory that wraps a backend with the
 * root-owned OAuth device-flow / refresh state machine.
 *
 * The root imports only the pure `/types` entry (never `/store`, `vscode`, or
 * any SDK); concrete backends live in `/store-backend` (fs) and `/positron`
 * (vscode) and are injected here.
 */

export type {
	AuthenticationChallenge,
	AuthenticationStartResult,
	CredentialMutation,
	CredentialProvider,
	CredentialSourceInput,
	CredentialStatus,
	Disposable,
	MutableCredentialProvider,
} from "./CredentialProvider";
export type {
	AcquisitionBackendHooks,
	AuthenticationCommitResult,
	AuthorizationCodeCallback,
	AuthorizationCodeReceiver,
	Backend,
	CredentialSourceContext,
	MutableBackend,
	OAuthBackendHooks,
	OAuthGrantConfig,
	OAuthProviderConfig,
	PreparedAuthorizationCodeReceiver,
	StoredOAuthTokens,
} from "./Backend";
export { createCredentialProvider } from "./createCredentialProvider";
export type {
	CreateCredentialProviderOptions,
	CredentialProviderHandle,
	MutableCredentialProviderHandle,
} from "./createCredentialProvider";
export {
	createDatabricksAuthorizationCodeGrant,
	createDatabricksClientCredentialsGrant,
	DATABRICKS_OAUTH_CLIENT_ID,
	DATABRICKS_OAUTH_SCOPES,
	discoverDatabricksOidcEndpoints,
	normalizeDatabricksWorkspaceHost,
} from "./databricks-oauth";
export type { DatabricksOidcEndpoints } from "./databricks-oauth";
