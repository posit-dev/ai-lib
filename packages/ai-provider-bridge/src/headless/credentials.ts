/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ResolvedConnection } from "ai-config";
import { shapeCredentials } from "ai-credentials/types";
import type { CredentialConfig, CredentialConfigTarget } from "ai-credentials/types";

import type { Logger, ProviderCredentials } from "../types.js";
import type { ServableProvider } from "./mappings.js";

type ConnectionFor = (providerId: string) => ResolvedConnection | undefined;

/**
 * Build a provider's credentials from a raw session token and the catalog.
 * Strictly read-only: it never creates a session.
 */
export function headlessCredentials(
	servable: ServableProvider,
	connectionFor: ConnectionFor,
	sessionToken: string | undefined,
	logger: Logger,
): ProviderCredentials | undefined {
	const providerId = servable.mapping.providerId;
	if (!servable.auth) {
		const endpoint = connectionFor(providerId)?.endpoint;
		return endpoint ? { type: "local", endpoint } : undefined;
	}
	if (sessionToken !== undefined) {
		const config = credentialConfig(connectionFor);
		return shapeCredentials(providerId, servable.auth, sessionToken, config, logger) ?? undefined;
	}
	const connection = connectionFor(providerId);
	return servable.apiKeyOptional
		? keylessCredentials(connection)
		: entraCredentials(providerId, connection);
}

/** A key-optional provider with no stored key runs on the catalog base URL alone, as Assistant's catalog fallback does. */
function keylessCredentials(
	connection: ResolvedConnection | undefined,
): ProviderCredentials | undefined {
	if (!connection?.baseUrl) {
		return undefined;
	}
	return {
		type: "apikey",
		apiKey: "",
		baseUrl: connection.baseUrl,
		customHeaders: connection.customHeaders,
	};
}

/** Foundry in Entra mode has no session; the bearer is minted per request from this secret-free credential. */
function entraCredentials(
	providerId: string,
	connection: ResolvedConnection | undefined,
): ProviderCredentials | undefined {
	if (providerId !== "ms-foundry") {
		return undefined;
	}
	if (connection?.azure?.authMode !== "entra" || !connection.azure.scope || !connection.baseUrl) {
		return undefined;
	}
	return {
		type: "azure-entra",
		baseUrl: connection.baseUrl,
		scope: connection.azure.scope,
		tenantId: connection.azure.tenantId,
		customHeaders: connection.customHeaders,
	};
}

function credentialConfig(catalogConnection: ConnectionFor): CredentialConfig {
	const connectionFor = (target: CredentialConfigTarget) => catalogConnection(target.providerId);
	return {
		getBaseUrl: (target) => connectionFor(target)?.baseUrl || undefined,
		getCustomHeaders: (target) => connectionFor(target)?.customHeaders,
		getAws: (target) => connectionFor(target)?.aws,
		getSnowflake: (target) => {
			const snowflake = connectionFor(target)?.snowflake;
			return snowflake && { host: snowflake.host, account: snowflake.account };
		},
		getDatabricks: (target) => connectionFor(target)?.databricks,
	};
}
