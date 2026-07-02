/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Store-backed credential Backend.
 *
 * Reads runtime credentials from the generic {@link SingleFileStore} with an
 * environment-variable fallback (`store → env → null`), and supplies the OAuth
 * device-flow hooks that the root state machine calls (option B). It owns the
 * on-disk {@link StoredProviderCredentials} shape (guarded by a tolerant Zod
 * schema) and the storage-key scheme via {@link storageKeyFor}.
 *
 * PURITY: imports `ai-credentials/store` (fs) + `ai-credentials/types` (pure)
 * and the root {@link Backend} type — but nothing from `@assistant/*`, so
 * standalone consumers (Notebooks) resolve credentials without the assistant
 * monorepo.
 *
 * Provider descriptors (which auth method a provider uses) are **injected** via
 * `resolveAuthMethod`, and OAuth connection config via `oauthConfigForProvider`,
 * so this backend needs neither the provider registry nor the catalog.
 */

import type {
	Backend,
	OAuthBackendHooks,
	OAuthProviderConfig,
	StoredOAuthTokens,
} from "../Backend";
import type { Disposable } from "../CredentialProvider";
import type { SingleFileStore } from "../store";
import type { Logger, ProviderCredentials, TokenData } from "../types";
import { storageKeyFor } from "../types";
import { resolveCredentialsFromEnv } from "./envCredentialResolver";
import {
	storedProviderCredentialsSchema,
	type StoredProviderCredentials,
} from "./StoredProviderCredentials";

/** Auth descriptor for a provider (injected — derived from registry/catalog). */
export interface AuthMethodDescriptor {
	authMethodId: string;
	apiKeyOptional?: boolean;
}

export interface CreateStoreBackendOptions {
	/** The generic single-file credential store. */
	store: SingleFileStore;
	/**
	 * Resolve a provider's auth method + flags. Returns undefined for unknown
	 * providers. Injected so the backend needs no registry/catalog import.
	 */
	resolveAuthMethod(providerId: string): AuthMethodDescriptor | undefined;
	/**
	 * OAuth connection config for device-flow providers (e.g. positai), or
	 * undefined for providers/hosts without device-flow support. When omitted
	 * entirely, the backend exposes no OAuth hooks.
	 */
	oauthConfigForProvider?: (providerId: string) => OAuthProviderConfig | undefined;
	/** Called when a provider's credentials become ready/refreshed. */
	notifyReady?: (providerId: string) => void;
	/**
	 * Provider ids whose store records should trigger `onDidChangeCredentials`
	 * on file change. Empty/omitted → the change subscription is a no-op.
	 */
	watchedProviderIds?: string[];
	/** Environment variables for the env fallback (defaults to `process.env`). */
	env?: Record<string, string | undefined>;
	logger?: Logger;
}

const NOOP_DISPOSABLE: Disposable = { dispose() {} };

/** Build a store-backed {@link Backend}. */
export function createStoreBackend(options: CreateStoreBackendOptions): Backend {
	const {
		store,
		resolveAuthMethod,
		oauthConfigForProvider,
		notifyReady,
		watchedProviderIds,
		env,
		logger,
	} = options;

	/**
	 * Read a credential record and validate it against the tolerant Zod schema
	 * (Phase 0 #5 runtime guard). Legacy records — which populate only a subset
	 * of fields — parse unchanged; structurally invalid records (e.g. an
	 * `apiKeyAuth` missing its required `apiKey`) are dropped rather than flowing
	 * out as credentials or into OAuth refresh. Returns undefined when the key is
	 * absent or the record fails validation.
	 */
	async function readRecord(key: string): Promise<StoredProviderCredentials | undefined> {
		const raw = await store.get<unknown>(key);
		if (raw === undefined) return undefined;
		const parsed = storedProviderCredentialsSchema.safeParse(raw);
		if (!parsed.success) {
			logger?.warn(
				`[ai-credentials/store-backend] Ignoring malformed credential record at ${key}: ${parsed.error.message}`,
			);
			return undefined;
		}
		return parsed.data;
	}

	async function getCredentials(providerId: string): Promise<ProviderCredentials | null> {
		const descriptor = resolveAuthMethod(providerId);
		if (!descriptor) return null;
		const { authMethodId, apiKeyOptional } = descriptor;

		// OAuth is resolved by the root state machine via the oauth hooks, not here.
		if (authMethodId === "oauth") return null;

		const stored = await readRecord(storageKeyFor(providerId, authMethodId));

		if (stored) {
			if (authMethodId === "apikey" && stored.apiKeyAuth) {
				// A stored-but-empty required key falls through to the env fallback.
				if (apiKeyOptional || stored.apiKeyAuth.apiKey) {
					return {
						type: "apikey",
						apiKey: stored.apiKeyAuth.apiKey,
						baseUrl: stored.apiKeyAuth.baseUrl,
					};
				}
			}

			if (authMethodId === "local" && stored.localAuth?.endpoint) {
				return { type: "local", endpoint: stored.localAuth.endpoint };
			}

			if (authMethodId === "aws-credentials" && stored.awsAuth?.region) {
				return {
					type: "aws-credentials",
					region: stored.awsAuth.region,
					profile: stored.awsAuth.profile,
					accessKeyId: stored.awsAuth.accessKeyId,
					secretAccessKey: stored.awsAuth.secretAccessKey,
					sessionToken: stored.awsAuth.sessionToken,
				};
			}

			if (authMethodId === "google-cloud" && stored.googleCloudAuth?.project) {
				return {
					type: "google-cloud",
					project: stored.googleCloudAuth.project,
					location: stored.googleCloudAuth.location,
				};
			}
		}

		// Fall back to environment variables (secret fields only).
		const envCredentials = resolveCredentialsFromEnv(providerId, env);
		if (envCredentials) {
			logger?.debug(`[ai-credentials/store-backend] Using env credentials for ${providerId}`);
			return envCredentials;
		}

		return null;
	}

	function onDidChangeCredentials(callback: (providerIds: string[]) => void): Disposable {
		if (!watchedProviderIds || watchedProviderIds.length === 0) {
			return NOOP_DISPOSABLE;
		}
		const ids = [...watchedProviderIds];
		return store.watch(() => callback(ids));
	}

	// --- OAuth hooks (only when device-flow config can be supplied) -----------
	let oauth: OAuthBackendHooks | undefined;
	if (oauthConfigForProvider) {
		const oauthKey = (providerId: string): string => storageKeyFor(providerId, "oauth");

		oauth = {
			configForProvider: oauthConfigForProvider,

			async readTokens(providerId: string): Promise<StoredOAuthTokens | null> {
				const stored = await readRecord(oauthKey(providerId));
				// Gate on authenticated: a refresh-failure record can keep stale
				// `oauthAuth.tokenData` while marked `authenticated: false`; those
				// tokens must not be treated as usable material.
				if (!stored || stored.authenticated !== true) return null;
				const tokenData = stored.oauthAuth?.tokenData;
				if (!tokenData) return null;
				return {
					accessToken: tokenData.accessToken,
					refreshToken: tokenData.refreshToken,
					expiresAt: tokenData.expiresAt,
					scope: tokenData.scope,
					tokenType: tokenData.tokenType,
				};
			},

			async persistTokens(providerId: string, tokens: TokenData): Promise<void> {
				const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000).toISOString();
				const record: StoredProviderCredentials = {
					authenticated: true,
					oauthAuth: {
						tokenData: {
							accessToken: tokens.accessToken,
							refreshToken: tokens.refreshToken,
							expiresAt,
							tokenType: tokens.tokenType,
							scope: tokens.scope,
						},
						expiresAt,
						scope: tokens.scope,
					},
					error: undefined,
				};
				await store.set(oauthKey(providerId), record);
			},

			async persistError(providerId: string, error: string): Promise<void> {
				await store.set(oauthKey(providerId), { authenticated: false, error });
			},

			notifyReady(providerId: string): void {
				notifyReady?.(providerId);
			},
		};
	}

	return oauth
		? { getCredentials, onDidChangeCredentials, oauth }
		: { getCredentials, onDidChangeCredentials };
}
