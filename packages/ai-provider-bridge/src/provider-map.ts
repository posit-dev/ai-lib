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
 * owns the id: Copilot uses GitHub's "github", and the Connect gateway uses
 * "posit-connect-llm" because Posit Publisher registers "posit-connect" for
 * deployment credentials.
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
	copilot: {
		authProviderId: "github",
		// Primary: the scope our `signInToCopilot` command requests. Preserves
		// existing behavior for users who have run that command.
		scopes: ["read:user"],
		// Fallbacks (silent-lookup only): reuse an existing GitHub session from
		// VS Code Copilot Chat / PR extension / etc. Aligned first because it is
		// a superset of read:user; then the narrowest user:email baseline.
		// Matches the "any-kind" ladder used by Copilot Chat's own session
		// lookup. The Copilot API validates subscription server-side, so any
		// GitHub OAuth token works regardless of scope.
		fallbackScopes: [["read:user", "user:email", "repo", "workflow"], ["user:email"]],
		credentialType: "apikey",
	},
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
