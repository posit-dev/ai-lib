/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Storage-key scheme for provider credentials.
 *
 * The canonical key format is `auth:{providerId}:{authMethodId}`. This helper
 * replaces the hand-authored `ProviderConfig.storageKey` values in core's
 * provider-registry and the synthesized keys in node's ProviderCatalogService.
 *
 * Lives in the pure `/types` entry (no fs/vscode/SDK) so core can import it.
 */

/**
 * Derive the credential storage key for a provider.
 *
 * @param providerId - The provider identifier (built-in or custom).
 * @param authMethodId - The auth method (e.g., "apikey", "oauth", "local").
 * @returns The canonical storage key, e.g. `"auth:anthropic:apikey"`.
 *
 * STABLE PERSISTED IDENTIFIER: These values are written to
 * `~/.posit/genai/auth/data.json` as keys for credential lookup. Renaming the
 * scheme without a migration will orphan existing credentials on disk.
 */
export function storageKeyFor(providerId: string, authMethodId: string): string {
	return `auth:${providerId}:${authMethodId}`;
}
