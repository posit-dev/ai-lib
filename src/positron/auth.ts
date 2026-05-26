/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";

import type { CredentialProvider, Disposable } from "../CredentialProvider";
import { MAPPED_PROVIDER_IDS, PROVIDER_MAP } from "../provider-map";
import type { Logger, ProviderId, ProviderCredentials } from "../types";
import { buildSnowflakeCortexUrl } from "../utils";

/**
 * Auth provider ID → VS Code settings config section.
 * Most providers use the auth provider ID directly; legacy `anthropic-api` maps to `anthropic`.
 */
const CONFIG_KEY_OVERRIDES: Record<string, string> = {
	"anthropic-api": "anthropic",
	"ms-foundry": "foundry",
	"snowflake-cortex": "snowflake",
};

/**
 * Try to get an auth session, normalizing expected failure modes to undefined.
 *
 * vscode.authentication.getSession() rejects when:
 * - The auth provider is not registered (older Positron, extension not installed)
 * - The user denies access
 * - Other unexpected errors
 *
 * All are treated as "no credentials available" (returns undefined),
 * but unexpected errors are logged at debug level for debuggability.
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
		logger.debug(`[positron-ai] Auth session unavailable for ${authProviderId}: ${err}`);
		return undefined;
	}
}

/**
 * Get credentials for a mapped LLM provider from Positron's auth system.
 *
 * Uses the Posit Assistant logical provider ID (e.g., 'anthropic', 'positai')
 * and maps it to the appropriate auth provider and scopes internally.
 *
 * Returns core ProviderCredentials directly (no providerId on credentials).
 *
 * Returns null when:
 * - The provider has no mapping
 * - The auth extension is not installed (older Positron)
 * - No credentials are configured for this provider
 * - The user denies access (when prompt: true)
 *
 * @param providerId - Posit Assistant logical provider ID (ProviderId)
 * @param options.prompt - If true, prompt user to sign in if no session exists.
 *                         Default: false (silent check only).
 * @returns Credentials, or null if not available
 */
async function getMappedCredentials(
	providerId: ProviderId,
	logger: Logger,
	options?: { prompt?: boolean },
): Promise<ProviderCredentials | null> {
	const mapping = PROVIDER_MAP[providerId];
	if (!mapping) return null;

	const { authProviderId, scopes, fallbackScopes, credentialType } = mapping;

	// silent and createIfNone are mutually exclusive overloads in the VS Code API.
	// Prompt path: only the primary scopes trigger createIfNone so the
	// deliberate sign-in UX (e.g. posit-assistant.signInToCopilot) is preserved.
	// Silent path: try primary first, then each fallback in order — this lets
	// us piggy-back on an existing GitHub session granted to another extension
	// (Copilot Chat, PR reviewer, …) without forcing a new OAuth grant.
	let session: vscode.AuthenticationSession | undefined;
	if (options?.prompt) {
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

	if (credentialType === "oauth") {
		return {
			type: "oauth",
			accessToken: session.accessToken,
		};
	}

	if (credentialType === "google-cloud") {
		// The Positron auth ext brokers credentials and serializes
		// {token, project, location} as JSON in session.accessToken.
		// The token is then passed to the Vertex SDK via googleAuthOptions.authClient
		// so the SDK does not have to resolve ADC itself.
		let parsed: { token?: string; project?: string; location?: string };
		try {
			parsed = JSON.parse(session.accessToken);
		} catch {
			logger.debug(`[positron-ai] Failed to parse Google Cloud credentials JSON for ${providerId}`);
			return null;
		}

		if (!parsed.token || !parsed.project || !parsed.location) {
			logger.debug(`[positron-ai] Google Cloud credentials missing token, project, or location`);
			return null;
		}

		return {
			type: "google-cloud",
			project: parsed.project,
			location: parsed.location,
			accessToken: parsed.token,
		};
	}

	if (credentialType === "aws-credentials") {
		// Parse JSON-serialized AWS credentials from auth session accessToken.
		// The auth extension stores {accessKeyId, secretAccessKey, sessionToken}.
		let parsed: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string };
		try {
			parsed = JSON.parse(session.accessToken);
		} catch {
			logger.debug(`[positron-ai] Failed to parse AWS credentials JSON for ${providerId}`);
			return null;
		}

		if (!parsed.accessKeyId || !parsed.secretAccessKey) {
			logger.debug(`[positron-ai] AWS credentials missing accessKeyId or secretAccessKey`);
			return null;
		}

		// Region is NOT in the auth session — read from VS Code settings, env var, or default.
		const awsConfig = vscode.workspace
			.getConfiguration("authentication.aws")
			.get<Record<string, string>>("credentials");
		const region = awsConfig?.AWS_REGION || process.env.AWS_REGION || "us-east-1";

		return {
			type: "aws-credentials",
			region,
			accessKeyId: parsed.accessKeyId,
			secretAccessKey: parsed.secretAccessKey,
			sessionToken: parsed.sessionToken,
		};
	}

	// Read baseUrl from VS Code settings for API key providers.
	// Config key mapping: most providers use auth provider ID directly;
	// exceptions: `anthropic-api` → `anthropic`, `ms-foundry` → `foundry`, etc.
	const configKey = CONFIG_KEY_OVERRIDES[authProviderId] ?? authProviderId;

	let baseUrl: string | undefined;

	if (providerId === "snowflake-cortex") {
		// Snowflake URL is constructed from host (preferred, for private-link/RCR) or account name.
		const snowflakeConfig = vscode.workspace
			.getConfiguration("authentication.snowflake")
			.get<Record<string, string>>("credentials");
		const host = snowflakeConfig?.SNOWFLAKE_HOST || process.env.SNOWFLAKE_HOST;
		const account = snowflakeConfig?.SNOWFLAKE_ACCOUNT || process.env.SNOWFLAKE_ACCOUNT;
		if (host) {
			baseUrl = `https://${host}/api/v2/cortex/v1`;
		} else if (account) {
			baseUrl = buildSnowflakeCortexUrl(account);
		}
	} else {
		baseUrl =
			vscode.workspace.getConfiguration("authentication").get<string>(`${configKey}.baseUrl`) ||
			undefined;
	}

	// Read customHeaders from the same `authentication.<configKey>` namespace
	// as baseUrl, so a provider's connection settings live in one place. Empty
	// objects are normalized to undefined to match the rest of the pipeline.
	const customHeadersRaw = vscode.workspace
		.getConfiguration("authentication")
		.get<Record<string, string>>(`${configKey}.customHeaders`);
	const customHeaders =
		customHeadersRaw && Object.keys(customHeadersRaw).length > 0 ? customHeadersRaw : undefined;

	return {
		type: "apikey",
		apiKey: session.accessToken,
		baseUrl,
		customHeaders,
	};
}

// ---------------------------------------------------------------------------
// Credential change event system for mapped providers
// ---------------------------------------------------------------------------

// Reverse map: auth provider ID -> Posit Assistant logical IDs.
// Built once at module scope from the static PROVIDER_MAP.
const AUTH_TO_LOGICAL = new Map<string, ProviderId[]>();
for (const logicalId of MAPPED_PROVIDER_IDS) {
	const mapping = PROVIDER_MAP[logicalId];
	if (!mapping) continue;
	const list = AUTH_TO_LOGICAL.get(mapping.authProviderId) ?? [];
	list.push(logicalId);
	AUTH_TO_LOGICAL.set(mapping.authProviderId, list);
}

// Internal merged emitter for mapped provider credential changes.
const credentialChangeEmitter = new vscode.EventEmitter<ProviderId[]>();

// Source 1: VS Code auth session changes
vscode.authentication.onDidChangeSessions((e) => {
	const logicalIds = AUTH_TO_LOGICAL.get(e.provider.id);
	if (logicalIds) {
		credentialChangeEmitter.fire(logicalIds);
	}
});

// Source 2: Base URL changes in VS Code settings for API key providers.
// Build a map of config keys → logical provider IDs from PROVIDER_MAP entries
// with credentialType: "apikey", so it automatically covers all mapped API key providers.
const BASE_URL_CONFIG_TO_LOGICAL = new Map<string, ProviderId[]>();
for (const logicalId of MAPPED_PROVIDER_IDS) {
	const mapping = PROVIDER_MAP[logicalId];
	if (!mapping || mapping.credentialType !== "apikey") continue;
	const configKey = CONFIG_KEY_OVERRIDES[mapping.authProviderId] ?? mapping.authProviderId;
	const list = BASE_URL_CONFIG_TO_LOGICAL.get(configKey) ?? [];
	list.push(logicalId);
	BASE_URL_CONFIG_TO_LOGICAL.set(configKey, list);
}

vscode.workspace.onDidChangeConfiguration((e) => {
	// baseUrl and customHeaders both live under `authentication.<configKey>`
	// for API key providers, so they share the same configKey → logicalIds map.
	for (const [configKey, logicalIds] of BASE_URL_CONFIG_TO_LOGICAL) {
		if (
			e.affectsConfiguration(`authentication.${configKey}.baseUrl`) ||
			e.affectsConfiguration(`authentication.${configKey}.customHeaders`)
		) {
			credentialChangeEmitter.fire(logicalIds);
		}
	}

	// Posit AI: baseUrl changes affect the gateway endpoint (e.g., switching to staging).
	if (e.affectsConfiguration("authentication.positai.baseUrl")) {
		credentialChangeEmitter.fire(["positai"]);
	}

	// Bedrock: region changes in AWS credentials settings affect model fetching and client endpoint.
	if (e.affectsConfiguration("authentication.aws.credentials")) {
		credentialChangeEmitter.fire(["bedrock"]);
	}

	// Snowflake: account changes affect the constructed base URL.
	if (e.affectsConfiguration("authentication.snowflake.credentials")) {
		credentialChangeEmitter.fire(["snowflake-cortex"]);
	}
});

/**
 * Subscribe to credential changes for mapped providers.
 * Does NOT include local provider changes — those are handled by the Positron extension.
 */
function onMappedCredentialsChanged(callback: (providerIds: ProviderId[]) => void): Disposable {
	return credentialChangeEmitter.event(callback);
}

// ---------------------------------------------------------------------------
// CredentialProvider implementation
// ---------------------------------------------------------------------------

/**
 * CredentialProvider implementation for Positron's mapped (non-local) providers.
 *
 * Wraps vscode.authentication.getSession() and config-based credential resolution.
 * Local providers (Ollama, LM Studio) are NOT covered — they remain in the
 * Positron extension's own code.
 */
export class PositronCredentialProvider implements CredentialProvider {
	private readonly logger: Logger;

	constructor(logger: Logger) {
		this.logger = logger;
	}

	getCredentials(providerId: ProviderId): Promise<ProviderCredentials | null> {
		return getMappedCredentials(providerId, this.logger);
	}

	getCredentialsWithPrompt(providerId: ProviderId): Promise<ProviderCredentials | null> {
		return getMappedCredentials(providerId, this.logger, { prompt: true });
	}

	onDidChangeCredentials(callback: (providerIds: ProviderId[]) => void): Disposable {
		return onMappedCredentialsChanged(callback);
	}
}
