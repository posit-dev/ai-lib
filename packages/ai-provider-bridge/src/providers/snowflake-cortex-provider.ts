/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ResolvedProviderId } from "ai-config";
import { getSnowflakeCortexModelCapabilities, SNOWFLAKE_CORTEX_CATALOG } from "ai-config";

import { SnowflakeClient } from "../model-clients/SnowflakeClient";
import type { SnowflakeSessionReauth } from "../model-clients/SnowflakeClient";
import type { Logger, ModelInfo, ProviderCredentials } from "../types";
import type { ClientFactory, ProviderRegistry } from "./ProviderRegistry";

/**
 * Platform-provided Snowflake hooks. Pre-built by the Node caller and threaded in
 * through registration; the bridge must NOT construct these.
 */
export interface SnowflakeProviderCallbacks {
	/**
	 * Reauthenticate an expired Snowflake **session** for a specific client-bound
	 * connection identity, returning a fresh session token. Only session auth
	 * (external-browser SSO) uses it; Bearer credentials never expire mid-request.
	 */
	reauthenticateSession: SnowflakeSessionReauth;
}

/**
 * The Snowflake Cortex model catalog, derived from `ai-config`'s Cortex table.
 *
 * Which models are offered, their display names, their token windows, and every
 * capability flag live in that one table — the same one capability inference
 * reads — so adding a model is a single edit there and a catalog entry can never
 * disagree with a user's `models.custom` override of the same id.
 */
function snowflakeModels(providerId: ResolvedProviderId): ModelInfo[] {
	return SNOWFLAKE_CORTEX_CATALOG.map((entry) => ({
		id: entry.id,
		name: entry.name,
		providerId,
		vendor: "snowflake-cortex",
		...getSnowflakeCortexModelCapabilities(entry.id),
	}));
}

function createSnowflakeModelFetcher(providerId: ResolvedProviderId, logger: Logger) {
	const fetcher = async (credentials: ProviderCredentials): Promise<ModelInfo[]> => {
		if (credentials.type !== "apikey") {
			logger.debug("[Snowflake] Wrong credential type, returning empty");
			return [];
		}
		if (!credentials.baseUrl) {
			logger.debug("[Snowflake] Missing baseUrl (no SNOWFLAKE_ACCOUNT), returning empty");
			return [];
		}
		return snowflakeModels(providerId);
	};
	fetcher.clearCache = () => {};
	return fetcher;
}

export function registerSnowflakeCortexProvider(
	registry: ProviderRegistry,
	logger: Logger,
	callbacks?: SnowflakeProviderCallbacks,
): void {
	registry.registerModelFetcher(
		"snowflake-cortex",
		createSnowflakeModelFetcher("snowflake-cortex", logger),
	);

	registry.registerClientFactory(
		"snowflake-cortex",
		createSnowflakeClientFactory(logger, callbacks),
	);
}

function createSnowflakeClientFactory(
	logger: Logger,
	callbacks?: SnowflakeProviderCallbacks,
): ClientFactory {
	return (credentials) => {
		if (credentials.type !== "apikey") {
			throw new Error(`Snowflake provider requires API key credentials, got: ${credentials.type}`);
		}
		// Session auth wires a client-bound refresh so an expired token retries the
		// connection *this* token came from, not whatever is currently selected.
		const session = credentials.snowflake;
		const sessionRefresh =
			session && callbacks
				? {
						connectionIdentity: session.sessionConnectionIdentity,
						reauthenticate: callbacks.reauthenticateSession,
					}
				: undefined;
		return new SnowflakeClient(
			credentials.apiKey,
			credentials.baseUrl!,
			session ? "session" : "bearer",
			credentials.customHeaders,
			sessionRefresh,
			logger,
		);
	};
}

export function registerCustomSnowflakeProvider(
	registry: ProviderRegistry,
	providerId: ResolvedProviderId,
	logger: Logger,
	callbacks?: SnowflakeProviderCallbacks,
): void {
	registry.registerModelFetcher(providerId, createSnowflakeModelFetcher(providerId, logger));
	registry.registerClientFactory(
		"snowflake-cortex",
		createSnowflakeClientFactory(logger, callbacks),
	);
}
