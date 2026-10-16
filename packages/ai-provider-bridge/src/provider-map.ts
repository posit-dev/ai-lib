/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { AuthProviderMapping } from "ai-credentials/types";

import { PROVIDER_IDS, type ProviderId } from "./types";

// Re-export so existing consumers of `ai-provider-bridge` can import it here.
export type { AuthProviderMapping } from "ai-credentials/types";

/** An {@link AuthProviderMapping} whose `authProviderId` defaults to the provider id. */
type MappingSpec = Omit<AuthProviderMapping, "authProviderId"> & { authProviderId?: string };

/**
 * Providers whose credentials resolve through an auth session.
 *
 * Auth provider ids equal catalog ids, except where another extension already
 * owns the id: the Connect gateway uses "posit-connect-llm" because Posit
 * Publisher registers "posit-connect" for deployment credentials.
 *
 * Not every provider has a mapping: local providers need no credentials, and
 * `copilot` is reached only through vscode.lm.
 */
const MAPPING_SPECS: Partial<Record<ProviderId, MappingSpec>> = {
	anthropic: { scopes: [], credentialType: "apikey" },
	positai: { scopes: ["positai"], credentialType: "oauth" },
	openai: { scopes: [], credentialType: "apikey" },
	gemini: { scopes: [], credentialType: "apikey" },
	litellm: { scopes: [], credentialType: "apikey" },
	portkey: { scopes: [], credentialType: "apikey" },
	opencode: { scopes: [], credentialType: "apikey" },
	"posit-connect": { authProviderId: "posit-connect-llm", scopes: [], credentialType: "apikey" },
	"openai-compatible": { scopes: [], credentialType: "apikey" },
	bedrock: { scopes: [], credentialType: "aws-credentials" },
	"ms-foundry": { scopes: [], credentialType: "apikey" },
	"snowflake-cortex": { scopes: [], credentialType: "apikey" },
	deepseek: { scopes: [], credentialType: "apikey" },
	// Bearer-token provider: session.accessToken is a PAT or OAuth access token
	// (the auth extension decides which); the workspace host comes from the
	// `authentication.databricks.credentials` setting.
	databricks: { scopes: [], credentialType: "apikey" },
	"google-vertex": { scopes: [], credentialType: "google-cloud" },
};

function isProviderId(value: string): value is ProviderId {
	return PROVIDER_IDS.some((id) => id === value);
}

export const PROVIDER_MAP: Partial<Record<ProviderId, AuthProviderMapping>> = {};
for (const [id, spec] of Object.entries(MAPPING_SPECS)) {
	if (spec && isProviderId(id)) {
		PROVIDER_MAP[id] = { ...spec, authProviderId: spec.authProviderId ?? id };
	}
}

/** Provider IDs that have auth mappings — public API for DirectModelService. */
export const MAPPED_PROVIDER_IDS: readonly ProviderId[] =
	Object.keys(PROVIDER_MAP).filter(isProviderId);
