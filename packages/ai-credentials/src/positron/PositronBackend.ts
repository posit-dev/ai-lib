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

import type { Backend, OAuthBackendHooks } from "../Backend";
import type { Disposable } from "../CredentialProvider";
import type { AuthProviderMapping, CredentialConfig, Logger, ProviderCredentials } from "../types";
import { shapeCredentials } from "../types";

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
 * Try to get an auth session, normalizing expected failure modes to undefined.
 */
async function tryGetSession(
	authProviderId: string,
	scopes: string[],
	options: { silent: true } | { createIfNone: true },
	logger: Logger,
): Promise<vscode.AuthenticationSession | undefined> {
	try {
		return await vscode.authentication.getSession(authProviderId, scopes, options);
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

	async function getMappedCredentials(
		providerId: string,
		prompt: boolean,
	): Promise<ProviderCredentials | null> {
		const mapping = providerMap[providerId];
		if (!mapping) return null;

		const { authProviderId, scopes, fallbackScopes } = mapping;

		let session: vscode.AuthenticationSession | undefined;
		if (prompt) {
			session = await tryGetSession(authProviderId, scopes, { createIfNone: true }, logger);
		} else {
			session = await tryGetSession(authProviderId, scopes, { silent: true }, logger);
			if (!session && fallbackScopes) {
				for (const fb of fallbackScopes) {
					session = await tryGetSession(authProviderId, fb, { silent: true }, logger);
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
