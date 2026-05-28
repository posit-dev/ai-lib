/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { PROVIDER_IDS, type ProviderId } from "./types";

/**
 * Maps Posit Assistant logical provider IDs to Positron auth provider config.
 *
 * - authProviderId: The VS Code authentication provider ID registered by
 *   Positron's auth extension (or Posit Workbench extension).
 * - scopes: Scopes to pass to vscode.authentication.getSession().
 *   Empty for API key providers; specific scope for OAuth providers
 *   where a single auth provider serves multiple logical providers.
 * - fallbackScopes: Optional ordered list of scope sets to try under
 *   silent lookup if the primary `scopes` yields no session. Only meaningful
 *   when one auth provider (e.g. GitHub) is shared across multiple granted
 *   scope buckets and we want to piggy-back on whichever session already
 *   exists. The prompt path (`createIfNone: true`) ignores these.
 * - credentialType: How to interpret session.accessToken.
 *
 * IMPORTANT: Only include providers that are confirmed to exist in
 * Positron's auth extension. Do not add speculative entries — each
 * provider has its own auth model (API key, OAuth, AWS credentials, etc.)
 * and the mapping must match what the auth extension actually implements.
 */
export interface AuthProviderMapping {
	authProviderId: string;
	scopes: string[];
	fallbackScopes?: string[][];
	credentialType: "apikey" | "oauth" | "aws-credentials" | "google-cloud";
}

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
