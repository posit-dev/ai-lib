/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";

import {
	CONFIG_KEY_OVERRIDES,
	type CredentialConfig,
	shapeCredentials,
} from "../credential-shaping";
import type { CredentialProvider, Disposable } from "../CredentialProvider";
import { MAPPED_PROVIDER_IDS, PROVIDER_MAP } from "../provider-map";
import type { Logger, ProviderId, ProviderCredentials } from "../types";

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
 * @param credentialConfigFactory - Factory for CredentialConfig. Defaults to
 *   createVscodeCredentialConfig() which reads from VS Code settings.
 * @returns Credentials, or null if not available
 */
async function getMappedCredentials(
	providerId: ProviderId,
	logger: Logger,
	options?: { prompt?: boolean },
	credentialConfigFactory: () => CredentialConfig = createVscodeCredentialConfig,
): Promise<ProviderCredentials | null> {
	const mapping = PROVIDER_MAP[providerId];
	if (!mapping) return null;

	const { authProviderId, scopes, fallbackScopes } = mapping;

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

	// The vscode session lookup above is the only auth-host-bound half; the
	// shaping below is pure and shared with Positron's headless facade.
	return shapeCredentials(mapping, session.accessToken, credentialConfigFactory(), logger);
}

/**
 * A {@link CredentialConfig} backed by VS Code settings, with `process.env`
 * fallbacks for the host environments (TUI / node) that set them. This is the
 * config-reading half the bridge supplies to {@link shapeCredentials}.
 */
export function createVscodeCredentialConfig(): CredentialConfig {
	return {
		getBaseUrl: (configKey) =>
			vscode.workspace.getConfiguration("authentication").get<string>(`${configKey}.baseUrl`),
		getCustomHeaders: (configKey) =>
			vscode.workspace
				.getConfiguration("authentication")
				.get<Record<string, string>>(`${configKey}.customHeaders`),
		getAwsRegion: () => {
			const awsConfig = vscode.workspace
				.getConfiguration("authentication.aws")
				.get<Record<string, string>>("credentials");
			return awsConfig?.AWS_REGION || process.env.AWS_REGION;
		},
		getSnowflake: () => {
			const snowflakeConfig = vscode.workspace
				.getConfiguration("authentication.snowflake")
				.get<Record<string, string>>("credentials");
			return {
				host: snowflakeConfig?.SNOWFLAKE_HOST || process.env.SNOWFLAKE_HOST,
				account: snowflakeConfig?.SNOWFLAKE_ACCOUNT || process.env.SNOWFLAKE_ACCOUNT,
			};
		},
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
	private readonly credentialConfigFactory: () => CredentialConfig;

	constructor(logger: Logger, credentialConfigFactory?: () => CredentialConfig) {
		this.logger = logger;
		this.credentialConfigFactory = credentialConfigFactory ?? createVscodeCredentialConfig;
	}

	getCredentials(providerId: ProviderId): Promise<ProviderCredentials | null> {
		return getMappedCredentials(providerId, this.logger, undefined, this.credentialConfigFactory);
	}

	getCredentialsWithPrompt(providerId: ProviderId): Promise<ProviderCredentials | null> {
		return getMappedCredentials(
			providerId,
			this.logger,
			{ prompt: true },
			this.credentialConfigFactory,
		);
	}

	onDidChangeCredentials(callback: (providerIds: ProviderId[]) => void): Disposable {
		return onMappedCredentialsChanged(callback);
	}
}
