/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Positron credential Backend — wraps `vscode.authentication`.
 *
 * Resolves runtime credentials for mapped (non-local) providers from Positron's
 * auth system, shaping the raw session token via the pure `/types`
 * {@link shapeCredentials}. It has **no** OAuth device-flow hooks: Positron's
 * auth extension owns the sign-in flow, so OAuth providers (e.g. positai)
 * resolve through {@link Backend.getCredentials} directly.
 *
 * The provider map is **injected** (from the bridge's `PROVIDER_MAP`) so this
 * entry carries no `ai-provider-bridge` import. Only `vscode` + `/types` + the
 * root {@link Backend} type.
 *
 * Ported from `ai-provider-bridge/positron/auth.ts`; Phase 7 repoints Positron
 * consumers here and removes the bridge copy.
 */

import * as vscode from "vscode";

import type { Backend, OAuthBackendHooks } from "../Backend.js";
import type { Disposable } from "../CredentialProvider.js";
import type {
	AuthProviderMapping,
	CredentialConfig,
	Logger,
	ProviderCredentials,
} from "../types/index.js";
import { shapeCredentials } from "../types/index.js";

/** A provider-id → auth mapping table (injected from the bridge's PROVIDER_MAP). */
export type ProviderMap = Readonly<Record<string, AuthProviderMapping | undefined>>;

/**
 * A {@link Backend} that additionally exposes a prompting credential lookup
 * (Positron's deliberate sign-in UX) and lifecycle disposal for its vscode
 * listeners. It never carries {@link OAuthBackendHooks}.
 */
export interface PositronBackend extends Backend {
	oauth?: never;
	/** Like getCredentials, but prompts the user to sign in when no session exists. */
	getCredentialsWithPrompt(providerId: string): Promise<ProviderCredentials | null>;
	/** Dispose the vscode session-change listener. */
	dispose(): void;
}

export interface CreatePositronBackendOptions {
	logger: Logger;
	/** Provider-id → auth mapping (the bridge's PROVIDER_MAP). */
	providerMap: ProviderMap;
	/** CredentialConfig factory (the host injects its catalog-backed adapter). */
	credentialConfigFactory: () => CredentialConfig;
}

/**
 * Whether an error from `getSession` is VS Code's "provider never registered"
 * timeout. `vscode.authentication.getSession(id, …, { silent: true })` does NOT
 * fail fast when `id` names an auth provider that isn't registered (e.g. a
 * provider whose auth extension isn't shipped in this host build) — it blocks
 * for several seconds waiting for the provider to register, then rejects with
 * "Timed out waiting for authentication provider '<id>' to register.".
 *
 * Matched on message text (VS Code exposes no typed error for it). We match the
 * canonical sentence contiguously, including the specific `authProviderId`, so
 * an unrelated error from a *registered* provider's session lookup that merely
 * contains some of the words (e.g. "failed to register refresh callback"), or a
 * reordered near-match, is not misclassified — that would wrongly, permanently
 * suppress the provider's silent lookups. Wording drift fails the match and
 * degrades to repeated waits, never an incorrect cached result.
 */
function isProviderNotRegisteredError(err: unknown, authProviderId: string): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return message.includes(`waiting for authentication provider '${authProviderId}' to register`);
}

/**
 * Prompt path (`createIfNone: true`): user-initiated sign-in. No latency cap or
 * negative-cache — an explicit sign-in should wait for the provider.
 */
async function tryCreateSession(
	authProviderId: string,
	scopes: string[],
	logger: Logger,
): Promise<vscode.AuthenticationSession | undefined> {
	try {
		return await vscode.authentication.getSession(authProviderId, scopes, { createIfNone: true });
	} catch (err) {
		logger.debug(
			`[ai-credentials/positron] Auth session unavailable for ${authProviderId}: ${err}`,
		);
		return undefined;
	}
}

/** Build a Positron {@link Backend} over the injected provider map. */
export function createPositronBackend(options: CreatePositronBackendOptions): PositronBackend {
	const { logger, providerMap, credentialConfigFactory } = options;

	const mappedProviderIds = Object.keys(providerMap).filter((id) => providerMap[id] !== undefined);

	// Auth provider ids observed to time out waiting to register (i.e. not shipped
	// in this host build). Cached for the process lifetime so the multi-second
	// registration wait is NOT re-paid on every silent lookup — a conversation
	// switch, model refresh, and auth-status poll each re-resolve every provider.
	// Once the verdict is cached, subsequent silent lookups for that provider are
	// instant. Entries are cleared when a session change is seen for the provider
	// (it registered), so recovery is automatic if the auth extension shows up
	// later.
	//
	// The cache is populated only after a lookup rejects, so concurrent first
	// lookups for the same provider (mapped providers resolve in parallel) can
	// each incur the wait once before the verdict lands — it is not coalesced.
	// This does not prolong callers already running in parallel. We deliberately
	// do NOT cap the lookup with a timeout: a short cap could return "no
	// credentials" for a registered provider that is merely slow to return an
	// existing session, and this path gates real chat requests (a null here
	// throws "No credentials available"). Correctness over shaving a one-time wait.
	const unregisteredAuthProviders = new Set<string>();

	async function trySilentSession(
		authProviderId: string,
		scopes: string[],
	): Promise<vscode.AuthenticationSession | undefined> {
		// Fast path: a provider already known to be unregistered would only block
		// for the full registration timeout again — skip the call entirely.
		if (unregisteredAuthProviders.has(authProviderId)) return undefined;

		try {
			const session = await vscode.authentication.getSession(authProviderId, scopes, {
				silent: true,
			});
			return session ?? undefined;
		} catch (err) {
			if (isProviderNotRegisteredError(err, authProviderId)) {
				unregisteredAuthProviders.add(authProviderId);
				logger.trace(
					`[ai-credentials/positron] Auth provider ${authProviderId} is not registered; skipping future silent lookups`,
				);
			} else {
				logger.debug(
					`[ai-credentials/positron] Auth session unavailable for ${authProviderId}: ${err}`,
				);
			}
			return undefined;
		}
	}

	async function getMappedCredentials(
		providerId: string,
		prompt: boolean,
	): Promise<ProviderCredentials | null> {
		const mapping = providerMap[providerId];
		if (!mapping) return null;

		const { authProviderId, scopes, fallbackScopes } = mapping;

		let session: vscode.AuthenticationSession | undefined;
		if (prompt) {
			session = await tryCreateSession(authProviderId, scopes, logger);
		} else {
			session = await trySilentSession(authProviderId, scopes);
			if (!session && fallbackScopes) {
				for (const fb of fallbackScopes) {
					session = await trySilentSession(authProviderId, fb);
					if (session) break;
				}
			}
		}

		if (!session) return null;
		return shapeCredentials(mapping, session.accessToken, credentialConfigFactory(), logger);
	}

	// --- Credential change events -------------------------------------------
	const emitter = new vscode.EventEmitter<string[]>();

	// Reverse map: auth provider id -> logical provider ids.
	const authToLogical = new Map<string, string[]>();
	for (const logicalId of mappedProviderIds) {
		const mapping = providerMap[logicalId];
		if (!mapping) continue;
		const list = authToLogical.get(mapping.authProviderId) ?? [];
		list.push(logicalId);
		authToLogical.set(mapping.authProviderId, list);
	}

	// The emitter fires ONLY on vscode auth session changes (login/logout).
	//
	// Connection-config changes (base URL, customHeaders, AWS region, Snowflake
	// host/account) are NOT signalled here. Those `authentication.*` settings are
	// folded into the resolved catalog as a `host` source (ai-config/positron), so
	// the catalog's debounced change event (catalogAdapter.onChange) is their
	// single source of truth. Wiring them up here too would race that event — the
	// immediate emitter would fire a refresh against the still-stale catalog
	// before the debounced rebuild lands.
	const sessionSub = vscode.authentication.onDidChangeSessions((e) => {
		// A session change means the provider is registered now: drop any stale
		// "unregistered" verdict so silent lookups resume against it.
		unregisteredAuthProviders.delete(e.provider.id);
		const logicalIds = authToLogical.get(e.provider.id);
		if (logicalIds) emitter.fire(logicalIds);
	});

	function onDidChangeCredentials(callback: (providerIds: string[]) => void): Disposable {
		return emitter.event(callback);
	}

	function dispose(): void {
		sessionSub.dispose();
		emitter.dispose();
	}

	return {
		getCredentials: (providerId: string) => getMappedCredentials(providerId, false),
		getCredentialsWithPrompt: (providerId: string) => getMappedCredentials(providerId, true),
		onDidChangeCredentials,
		dispose,
	};
}
