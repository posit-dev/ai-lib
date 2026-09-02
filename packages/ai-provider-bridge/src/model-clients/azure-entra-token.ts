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

import {
	ClientCertificateCredential,
	ClientSecretCredential,
	DefaultAzureCredential,
	getBearerTokenProvider,
} from "@azure/identity";

/** A function that resolves a fresh bearer token, refreshing as needed. */
export type BearerTokenProvider = () => Promise<string>;

const ambientTokenProviderCache = new Map<string, BearerTokenProvider>();
let capturedTokenProviderCaches = new WeakMap<
	Readonly<Record<string, string | undefined>>,
	Map<string, BearerTokenProvider>
>();

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
	credentialEnvironment?: Readonly<Record<string, string | undefined>>,
): BearerTokenProvider {
	const cacheKey = JSON.stringify([tenantId ?? null, scope]);
	const cache = credentialEnvironment
		? (capturedTokenProviderCaches.get(credentialEnvironment) ??
			new Map<string, BearerTokenProvider>())
		: ambientTokenProviderCache;
	if (credentialEnvironment && !capturedTokenProviderCaches.has(credentialEnvironment)) {
		capturedTokenProviderCaches.set(credentialEnvironment, cache);
	}
	let provider = cache.get(cacheKey);
	if (!provider) {
		const acquire = getBearerTokenProvider(
			createAzureCredential(tenantId, credentialEnvironment),
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
		cache.set(cacheKey, provider);
	}
	return provider;
}

/** Test-only: drop every cached token provider. */
export function clearAzureEntraTokenProviderCache(): void {
	ambientTokenProviderCache.clear();
	capturedTokenProviderCaches = new WeakMap();
}

function createAzureCredential(
	tenantId: string | undefined,
	env: Readonly<Record<string, string | undefined>> | undefined,
) {
	if (env) {
		const effectiveTenantId = tenantId ?? env.AZURE_TENANT_ID;
		const clientId = env.AZURE_CLIENT_ID;
		if (effectiveTenantId && clientId && env.AZURE_CLIENT_SECRET) {
			return new ClientSecretCredential(effectiveTenantId, clientId, env.AZURE_CLIENT_SECRET);
		}
		if (effectiveTenantId && clientId && env.AZURE_CLIENT_CERTIFICATE_PATH) {
			return new ClientCertificateCredential(effectiveTenantId, clientId, {
				certificatePath: env.AZURE_CLIENT_CERTIFICATE_PATH,
				certificatePassword: env.AZURE_CLIENT_CERTIFICATE_PASSWORD,
			});
		}
	}
	return new DefaultAzureCredential(tenantId ? { tenantId } : {});
}
