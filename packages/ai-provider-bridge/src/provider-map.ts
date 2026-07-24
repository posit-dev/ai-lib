/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { AuthProviderMapping } from "ai-credentials/types";

import { PROVIDER_IDS, type ProviderId } from "./types";

// Re-export so existing consumers of `ai-provider-bridge` can import it here.
export type { AuthProviderMapping } from "ai-credentials/types";

/**
 * Confirmed provider mappings only.
 * Add new entries as Positron's auth extension ships support for each provider.
 */
export const PROVIDER_MAP: Partial<Record<ProviderId, AuthProviderMapping>> = {
	anthropic: { authProviderId: "anthropic-api", scopes: [], credentialType: "apikey" },
	positai: { authProviderId: "posit-ai", scopes: ["positai"], credentialType: "oauth" },
	openai: { authProviderId: "openai-api", scopes: [], credentialType: "apikey" },
	gemini: { authProviderId: "google", scopes: [], credentialType: "apikey" },
	"openai-compatible": {
		authProviderId: "openai-compatible",
		scopes: [],
		credentialType: "apikey",
	},
	bedrock: {
		authProviderId: "amazon-bedrock",
		scopes: [],
		credentialType: "aws-credentials",
	},
	"ms-foundry": {
		authProviderId: "ms-foundry",
		scopes: [],
		credentialType: "apikey",
	},
	"snowflake-cortex": {
		authProviderId: "snowflake-cortex",
		scopes: [],
		credentialType: "apikey",
	},
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
	deepseek: { authProviderId: "deepseek-api", scopes: [], credentialType: "apikey" },
	// Bearer-token provider: session.accessToken is a PAT or OAuth access token
	// (the auth extension decides which); the workspace host comes from the
	// `authentication.databricks.credentials` setting.
	databricks: { authProviderId: "databricks", scopes: [], credentialType: "apikey" },
	"google-vertex": {
		authProviderId: "google-cloud",
		scopes: [],
		credentialType: "google-cloud",
	},
};

function isProviderId(value: string): value is ProviderId {
	return PROVIDER_IDS.some((id) => id === value);
}

/** Provider IDs that have auth mappings — public API for DirectModelService. */
export const MAPPED_PROVIDER_IDS: readonly ProviderId[] =
	Object.keys(PROVIDER_MAP).filter(isProviderId);
