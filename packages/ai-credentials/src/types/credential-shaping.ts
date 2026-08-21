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

import type { ProviderCredentials } from "./credentials.js";
import type { Logger } from "./logger.js";
import {
	buildSnowflakeCortexUrl,
	buildSnowflakeCortexUrlFromHost,
	normalizeDatabricksHost,
} from "./utils.js";

/**
 * Which structured connection fields a provider builds its base URL from, for
 * the providers that don't use a plain `baseUrl`.
 */
export type StructuredBaseUrlSource = "snowflake" | "databricks";

/**
 * Maps a provider to its auth extension registration and credential type.
 * Subset of the full mapping — shaping only needs these fields.
 */
export interface AuthProviderMapping {
	authProviderId: string;
	scopes: string[];
	fallbackScopes?: string[][];
	credentialType: "apikey" | "oauth" | "aws-credentials" | "google-cloud";
	/**
	 * Set for `providers.custom` entries whose base URL comes from structured
	 * fields. Built-in providers are recognized by their auth provider id
	 * ({@link BUILTIN_STRUCTURED_BASE_URL}); a custom entry's id is the user's
	 * chosen name, so its mapping has to say so.
	 */
	structuredBaseUrl?: StructuredBaseUrlSource;
}

/**
 * Built-in providers whose `apikey` base URL is derived from structured
 * connection fields rather than a plain `baseUrl`.
 *
 * Kept here rather than in the injected mapping so hosts that hand-build
 * mappings for built-ins keep their derivation.
 */
const BUILTIN_STRUCTURED_BASE_URL: Record<string, StructuredBaseUrlSource | undefined> = {
	"snowflake-cortex": "snowflake",
	databricks: "databricks",
};

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
/**
 * Which provider a {@link CredentialConfig} read is for.
 *
 * Two fields because the two jobs need different keys, and only one of them is
 * unique:
 *
 * - `providerId` is the identity. A built-in provider id or a `providers.custom`
 *   entry id, and the two spaces can't collide because custom names reserve
 *   every built-in id. Catalog-backed adapters answer from this.
 * - `configKey` is the settings namespace (`authentication.<configKey>.*`) that
 *   settings-backed adapters read. It is **not** unique: `snowflake-cortex`
 *   derives the configKey `snowflake`, which is itself a legal custom entry
 *   name, so a reader that identifies a provider by configKey alone will hand a
 *   custom entry the built-in's connection.
 *
 * Passed as an object rather than two string parameters so the two can't be
 * transposed silently.
 */
export interface CredentialConfigTarget {
	readonly providerId: string;
	readonly configKey: string;
}

/**
 * Reads the provider-extra config that shaping needs, abstracted over the
 * config source. Hosts inject catalog-backed adapters (reading the resolved
 * provider catalog's connection fields); Positron's renderer adapter reads its
 * own `IConfigurationService`. The shaper owns *which* keys to read (via
 * {@link CredentialConfigTarget}) so neither caller has to.
 *
 * Every reader must answer for the requested provider only. A `providers.custom`
 * entry has its own connection, so a host serving custom entries cannot answer
 * from a fixed built-in provider: a named `type: "aws"` entry would inherit
 * `bedrock`'s region.
 */
export interface CredentialConfig {
	/** `authentication.<configKey>.baseUrl` (the shaper normalizes empty -> undefined). */
	getBaseUrl(target: CredentialConfigTarget): string | undefined;
	/** `authentication.<configKey>.customHeaders`. */
	getCustomHeaders(target: CredentialConfigTarget): Record<string, string> | undefined;
	/** AWS region/profile, from the resolved catalog's `connection.aws`. */
	getAws(target: CredentialConfigTarget): { region?: string; profile?: string } | undefined;
	/** Snowflake host/account (`authentication.snowflake.credentials`, env on the bridge side). */
	getSnowflake(target: CredentialConfigTarget): { host?: string; account?: string } | undefined;
	/** Databricks workspace host (`authentication.databricks.credentials`, env on the bridge side). */
	getDatabricks(target: CredentialConfigTarget): { host?: string } | undefined;
}

/**
 * Shape an already-resolved auth token into {@link ProviderCredentials}, or
 * `null` when the token cannot yield usable credentials (malformed JSON, missing
 * required fields). The mapping supplies the credential type and the auth
 * provider id (from which the settings `configKey` is derived); `providerId`
 * identifies which provider is being resolved, since the derived configKey does
 * not (see {@link CredentialConfigTarget}); `config` reads the provider-extra
 * settings.
 */
export function shapeCredentials(
	providerId: string,
	mapping: Pick<AuthProviderMapping, "authProviderId" | "credentialType" | "structuredBaseUrl">,
	rawToken: string,
	config: CredentialConfig,
	logger?: Logger,
): ProviderCredentials | null {
	const target: CredentialConfigTarget = {
		providerId,
		configKey: CONFIG_KEY_OVERRIDES[mapping.authProviderId] ?? mapping.authProviderId,
	};

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
			const aws = config.getAws(target);
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
			let baseUrl: string | undefined;
			switch (mapping.structuredBaseUrl ?? BUILTIN_STRUCTURED_BASE_URL[mapping.authProviderId]) {
				case "snowflake": {
					// Snowflake URL is built from host (preferred, for private-link/RCR) or
					// account name, then a flat `baseUrl` as written. Structured wins so a
					// stale URL can't shadow it, but the flat form has to resolve too: it is
					// what standalone's Add-custom-provider form writes in custom-URL mode,
					// it is the only shape that can express a non-standard Cortex path, and
					// the other hosts already honour it (`conn.baseUrl ?? derive(conn)`).
					const snowflake = config.getSnowflake(target);
					if (snowflake?.host) {
						baseUrl = buildSnowflakeCortexUrlFromHost(snowflake.host);
					} else if (snowflake?.account) {
						baseUrl = buildSnowflakeCortexUrl(snowflake.account);
					} else {
						baseUrl = config.getBaseUrl(target) || undefined;
					}
					break;
				}
				case "databricks": {
					// Databricks workspace host, with env fallback for managed environments
					// (e.g. Posit Workbench injecting DATABRICKS_HOST into sessions).
					const databricks = config.getDatabricks(target);
					if (databricks?.host) {
						baseUrl = normalizeDatabricksHost(databricks.host);
					}
					break;
				}
				default:
					baseUrl = config.getBaseUrl(target) || undefined;
			}

			// customHeaders share the `authentication.<configKey>` namespace with
			// baseUrl. Empty objects normalize to undefined to match the pipeline.
			const customHeadersRaw = config.getCustomHeaders(target);
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
