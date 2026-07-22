/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure, platform-neutral credential shaping.
 *
 * This is the half of credential resolution that does NOT touch `vscode`: given
 * an already-resolved auth token and a {@link CredentialConfig} that reads the
 * relevant `authentication.*` settings, it produces the {@link ProviderCredentials}
 * a provider client expects. Session lookup (the `vscode`-bound half) stays with
 * the caller -- {@link PositronCredentialProvider} in the bridge, and Positron's
 * headless language-model facade, which reads the same settings off its own
 * `IConfigurationService` instead of `vscode.workspace`.
 *
 * It imports only local types and utils, so it carries no `vscode`, AI-SDK, or
 * Node-builtin dependency and is safe to bundle into a browser/renderer. Keep
 * it that way.
 */

import type { ProviderCredentials } from "./credentials";
import type { Logger } from "./logger";
import { buildSnowflakeCortexUrl, buildSnowflakeCortexUrlFromHost } from "./utils";

/**
 * Maps a provider to its auth extension registration and credential type.
 * Subset of the full mapping — shaping only needs these two fields.
 */
export interface AuthProviderMapping {
	authProviderId: string;
	scopes: string[];
	fallbackScopes?: string[][];
	credentialType: "apikey" | "oauth" | "aws-credentials" | "google-cloud";
}

/**
 * Auth provider ID -> VS Code settings config section.
 * Most providers use the auth provider ID directly; legacy `anthropic-api` maps to `anthropic`.
 */
export const CONFIG_KEY_OVERRIDES: Record<string, string> = {
	"anthropic-api": "anthropic",
	"ms-foundry": "foundry",
	"snowflake-cortex": "snowflake",
};

/**
 * Reads the provider-extra config that shaping needs, abstracted over the
 * config source. Hosts inject catalog-backed adapters (reading the resolved
 * provider catalog's connection fields); Positron's renderer adapter reads its
 * own `IConfigurationService`. The shaper owns *which* keys to read (via
 * `configKey`) so neither caller has to.
 */
export interface CredentialConfig {
	/** `authentication.<configKey>.baseUrl` (the shaper normalizes empty -> undefined). */
	getBaseUrl(configKey: string): string | undefined;
	/** `authentication.<configKey>.customHeaders`. */
	getCustomHeaders(configKey: string): Record<string, string> | undefined;
	/** AWS region/profile, from the resolved catalog's `connection.aws`. */
	getAws(): { region?: string; profile?: string } | undefined;
	/** Snowflake host/account (`authentication.snowflake.credentials`, env on the bridge side). */
	getSnowflake(): { host?: string; account?: string } | undefined;
}

/**
 * Shape an already-resolved auth token into {@link ProviderCredentials}, or
 * `null` when the token cannot yield usable credentials (malformed JSON, missing
 * required fields). The mapping supplies the credential type and the auth
 * provider id (from which the settings `configKey` is derived); `config` reads
 * the provider-extra settings.
 */
export function shapeCredentials(
	mapping: Pick<AuthProviderMapping, "authProviderId" | "credentialType">,
	rawToken: string,
	config: CredentialConfig,
	logger?: Logger,
): ProviderCredentials | null {
	switch (mapping.credentialType) {
		case "oauth":
			return { type: "oauth", accessToken: rawToken };

		case "google-cloud": {
			// The Positron auth ext brokers credentials and serializes
			// {project, location, token?} as JSON. When token is present it is
			// passed to the Vertex SDK; otherwise the SDK falls back to ADC.
			const parsed = parseJson(rawToken);
			if (!parsed) {
				logger?.debug(
					`[positron-ai] Failed to parse Google Cloud credentials JSON for ${mapping.authProviderId}`,
				);
				return null;
			}
			const project = getStringField(parsed, "project");
			const location = getStringField(parsed, "location");
			const accessToken = getStringField(parsed, "token");
			if (!project || !location) {
				logger?.debug(`[positron-ai] Google Cloud credentials missing project or location`);
				return null;
			}
			const credentials: GoogleCloudCredentialsResult = { type: "google-cloud", project, location };
			return accessToken ? { ...credentials, accessToken } : credentials;
		}

		case "aws-credentials": {
			// The auth ext stores {accessKeyId, secretAccessKey, sessionToken} as JSON.
			const parsed = parseJson(rawToken);
			if (!parsed) {
				logger?.debug(
					`[positron-ai] Failed to parse AWS credentials JSON for ${mapping.authProviderId}`,
				);
				return null;
			}
			const accessKeyId = getStringField(parsed, "accessKeyId");
			const secretAccessKey = getStringField(parsed, "secretAccessKey");
			if (!accessKeyId || !secretAccessKey) {
				logger?.debug(`[positron-ai] AWS credentials missing accessKeyId or secretAccessKey`);
				return null;
			}
			// Region is not in the session -- the adapter resolves settings/env, default us-east-1.
			const aws = config.getAws();
			return {
				type: "aws-credentials",
				region: aws?.region || "us-east-1",
				accessKeyId,
				secretAccessKey,
				sessionToken: getStringField(parsed, "sessionToken"),
				profile: aws?.profile,
			};
		}

		case "apikey": {
			const configKey = CONFIG_KEY_OVERRIDES[mapping.authProviderId] ?? mapping.authProviderId;

			let baseUrl: string | undefined;
			if (mapping.authProviderId === "snowflake-cortex") {
				// Snowflake URL is built from host (preferred, for private-link/RCR) or account name.
				const snowflake = config.getSnowflake();
				if (snowflake?.host) {
					baseUrl = buildSnowflakeCortexUrlFromHost(snowflake.host);
				} else if (snowflake?.account) {
					baseUrl = buildSnowflakeCortexUrl(snowflake.account);
				}
			} else {
				baseUrl = config.getBaseUrl(configKey) || undefined;
			}

			// customHeaders share the `authentication.<configKey>` namespace with
			// baseUrl. Empty objects normalize to undefined to match the pipeline.
			const customHeadersRaw = config.getCustomHeaders(configKey);
			const customHeaders =
				customHeadersRaw && Object.keys(customHeadersRaw).length > 0 ? customHeadersRaw : undefined;

			return { type: "apikey", apiKey: rawToken, baseUrl, customHeaders };
		}
	}
}

/** Narrowed local alias so the optional-accessToken spread above stays typed. */
type GoogleCloudCredentialsResult = Extract<ProviderCredentials, { type: "google-cloud" }>;

function parseJson(text: string): unknown | null {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function getStringField(value: unknown, field: string): string | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	const fieldValue: unknown = Reflect.get(value, field);
	return typeof fieldValue === "string" && fieldValue.length > 0 ? fieldValue : undefined;
}
