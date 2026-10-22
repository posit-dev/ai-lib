/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { isBuiltinProviderId, isSupportedCustomClientKind } from "ai-config";
import type { ResolvedProvider, SupportedCustomClientKind } from "ai-config";
import { customProviderAuthMapping, resolveCustomAuthMapping } from "ai-credentials/types";
import type { AuthProviderMapping } from "ai-credentials/types";

import { isLocalProviderId, LOCAL_PROVIDER_IDS } from "../local-providers.js";
import { MAPPED_PROVIDER_IDS, PROVIDER_MAP } from "../provider-map.js";
import type { HeadlessProviderMapping } from "./types.js";

/** The aggregate auth provider id Assistant registers for `providers.custom` entries. */
export const CUSTOM_PROVIDERS_AUTH_PROVIDER_ID = "custom-providers";

/**
 * Built-in providers that work without an API key once the catalog gives them a base URL.
 * Mirrors `apiKeyOptional` in Assistant's provider registry. Built-in Portkey is absent on
 * purpose: hosted and self-hosted modes both need a secret.
 */
const KEYLESS_BUILT_IN_PROVIDER_IDS: ReadonlySet<string> = new Set([
	"litellm",
	"openai-compatible",
]);

export interface ServableProvider {
	readonly mapping: HeadlessProviderMapping;
	/** The `PROVIDER_MAP` or `customProviderAuthMapping` entry, passed to `shapeCredentials` as is; absent for local providers. */
	readonly auth?: AuthProviderMapping;
	readonly clientKind?: SupportedCustomClientKind;
	/** True when a catalog base URL alone is enough to build credentials, so no session is needed. */
	readonly apiKeyOptional?: true;
}

function localServable(
	providerId: string,
	clientKind?: SupportedCustomClientKind,
): ServableProvider {
	return {
		mapping: { providerId, scopes: [], requiresSession: false },
		...(clientKind && { clientKind }),
	};
}

function authServable(
	providerId: string,
	auth: AuthProviderMapping,
	requiresSession: boolean,
	options: { clientKind?: SupportedCustomClientKind; apiKeyOptional?: boolean },
): ServableProvider {
	return {
		mapping: {
			providerId,
			authProviderId: auth.authProviderId,
			scopes: auth.scopes,
			requiresSession,
		},
		auth,
		...(options.clientKind && { clientKind: options.clientKind }),
		...(options.apiKeyOptional && { apiKeyOptional: true as const }),
	};
}

function builtInServables(catalog: readonly ResolvedProvider[]): ServableProvider[] {
	return MAPPED_PROVIDER_IDS.flatMap((providerId) => {
		const auth = PROVIDER_MAP[providerId];
		if (!auth) {
			return [];
		}
		const entraFoundry =
			providerId === "ms-foundry" &&
			catalog.find((provider) => provider.id === providerId)?.connection.azure?.authMode ===
				"entra";
		const apiKeyOptional = KEYLESS_BUILT_IN_PROVIDER_IDS.has(providerId);
		return [authServable(providerId, auth, !entraFoundry && !apiKeyOptional, { apiKeyOptional })];
	});
}

function customServables(catalog: readonly ResolvedProvider[]): ServableProvider[] {
	return catalog.flatMap((provider) => {
		const kind = provider.clientKind;
		if (isBuiltinProviderId(provider.id) || !isSupportedCustomClientKind(kind)) {
			return [];
		}
		if (isLocalProviderId(kind)) {
			return [localServable(provider.id, kind)];
		}
		const auth = customProviderAuthMapping(provider.id, kind, CUSTOM_PROVIDERS_AUTH_PROVIDER_ID);
		if (!auth) {
			return [];
		}
		const apiKeyOptional =
			provider.authPolicy?.apiKeyOptional ?? resolveCustomAuthMapping(kind)?.apiKeyOptional;
		return [authServable(provider.id, auth, !apiKeyOptional, { clientKind: kind, apiKeyOptional })];
	});
}

/** The providers headless can serve for a catalog, with the auth session each needs. */
export function servableProviders(catalog: readonly ResolvedProvider[]): ServableProvider[] {
	return [
		...builtInServables(catalog),
		...LOCAL_PROVIDER_IDS.map((providerId) => localServable(providerId)),
		...customServables(catalog),
	];
}
