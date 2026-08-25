/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Microsoft Entra ID bearer-token acquisition for Azure-backed providers
 * (Microsoft Foundry).
 *
 * `@azure/identity`'s `DefaultAzureCredential` owns the whole token
 * lifecycle: it chains environment / workload-identity / managed-identity /
 * Azure CLI (`az login`) credentials and caches + refreshes tokens in memory
 * per credential instance. That caching is per-instance, so this module keeps
 * a process-level cache of bearer providers keyed by scope+tenant — callers
 * must never construct a new `DefaultAzureCredential` per request.
 */

import { DefaultAzureCredential, getBearerTokenProvider } from "@azure/identity";

/** A function that resolves a fresh bearer token, refreshing as needed. */
export type BearerTokenProvider = () => Promise<string>;

const tokenProviderCache = new Map<string, BearerTokenProvider>();

function isCredentialUnavailable(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (error.name === "CredentialUnavailableError") return true;
	if (error.name !== "AggregateAuthenticationError" || !("errors" in error)) return false;
	const errors = error.errors;
	return Array.isArray(errors) && errors.length > 0 && errors.every(isCredentialUnavailable);
}

/**
 * Return a cached bearer-token provider for `scope` (+ optional `tenantId`).
 *
 * Token acquisition failures are normalized into an actionable error: the
 * most common cause is that no credential in the DefaultAzureCredential
 * chain is available (the user never ran `az login`), and the raw Azure SDK
 * chain error does not say so.
 */
export function createAzureEntraTokenProvider(
	scope: string,
	tenantId?: string,
): BearerTokenProvider {
	const cacheKey = JSON.stringify([tenantId ?? null, scope]);
	let provider = tokenProviderCache.get(cacheKey);
	if (!provider) {
		const acquire = getBearerTokenProvider(
			new DefaultAzureCredential(tenantId ? { tenantId } : {}),
			scope,
		);
		provider = async () => {
			try {
				return await acquire();
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				if (isCredentialUnavailable(error)) {
					throw new Error(
						"Microsoft Entra ID authentication failed: no usable Azure credential was found. " +
							"Sign in with `az login` (or configure a managed identity / service principal " +
							"environment), then try again. " +
							"See https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/how-to/configure-entra-id " +
							`for setup guidance. Underlying error: ${detail}`,
					);
				}
				throw new Error(
					"Microsoft Entra ID token acquisition failed. Verify the configured tenant ID and " +
						`scope, then try again. Underlying error: ${detail}`,
				);
			}
		};
		tokenProviderCache.set(cacheKey, provider);
	}
	return provider;
}

/** Test-only: drop every cached token provider. */
export function clearAzureEntraTokenProviderCache(): void {
	tokenProviderCache.clear();
}
