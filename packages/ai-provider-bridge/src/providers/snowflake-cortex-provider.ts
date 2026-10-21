/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ResolvedProviderId } from "ai-config";
import { getSnowflakeCortexModelCapabilities, SNOWFLAKE_CORTEX_CATALOG } from "ai-config";

import { additiveHeaderRecord } from "../custom-headers";
import { createSnowflakeSessionFetch, SnowflakeClient } from "../model-clients/SnowflakeClient";
import type { SnowflakeSessionReauth } from "../model-clients/SnowflakeClient";
import type { ApiKeyCredentials, Logger, ModelInfo } from "../types";
import type { ClearableModelFetcher } from "./cached-model-fetcher";
import { createCachedModelFetcher, DEFAULT_DISCOVERY_DEADLINE_MS } from "./cached-model-fetcher";
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

/** Lists the models the user's default role can use, with their lifecycle stage. */
const SHOW_MODELS_STATEMENT = "SHOW CORTEX BASE MODELS IN SCHEMA SNOWFLAKE.MODELS";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Lowercased names of the non-`EOL` models in a SQL API v2 result for
 * {@link SHOW_MODELS_STATEMENT}. Throws on any other shape, including a 202
 * async-execution response (which carries no result set).
 */
function accessibleModelNames(body: unknown): Set<string> {
	const meta = isRecord(body) ? body.resultSetMetaData : undefined;
	const rows = isRecord(body) ? body.data : undefined;
	if (!isRecord(meta) || !Array.isArray(meta.rowType) || !Array.isArray(rows)) {
		throw new Error("Snowflake SQL API response has no result set");
	}
	const columns = meta.rowType.map((column: unknown) =>
		isRecord(column) && typeof column.name === "string" ? column.name.toLowerCase() : undefined,
	);
	const nameIndex = columns.indexOf("name");
	const statusIndex = columns.indexOf("lifecycle_status");
	if (nameIndex < 0 || statusIndex < 0) {
		throw new Error("Snowflake SQL API result lacks name/lifecycle_status columns");
	}
	const names = new Set<string>();
	for (const row of rows) {
		const name: unknown = Array.isArray(row) ? row[nameIndex] : undefined;
		if (typeof name !== "string") {
			throw new Error("Snowflake SQL API result has a malformed row");
		}
		if (row[statusIndex] !== "EOL") names.add(name.toLowerCase());
	}
	return names;
}

/**
 * Model discovery: the static catalog, narrowed to the models the account's
 * default role can access (via `SHOW CORTEX BASE MODELS` through the SQL API).
 * Any failure — or a result matching no catalog id — falls back to the stale
 * cache, then the full catalog.
 */
function createSnowflakeModelFetcher(
	providerId: ResolvedProviderId,
	logger: Logger,
): ClearableModelFetcher {
	const catalog = snowflakeModels(providerId);
	const cached = createCachedModelFetcher<ApiKeyCredentials>({
		providerId,
		// The outer guard below has already required apikey credentials and a baseUrl.
		hasCredentials: () => true,
		fetchFresh: async (credentials, signal) => {
			// The session fetch replaces this Bearer header with `Snowflake Token="..."`.
			const headers = additiveHeaderRecord(
				{
					Authorization: `Bearer ${credentials.apiKey}`,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				credentials.customHeaders,
			);
			const send = credentials.snowflake
				? createSnowflakeSessionFetch(credentials.apiKey, fetch)
				: fetch;
			const response = await send(new URL("/api/v2/statements", credentials.baseUrl), {
				method: "POST",
				headers,
				body: JSON.stringify({
					statement: SHOW_MODELS_STATEMENT,
					timeout: DEFAULT_DISCOVERY_DEADLINE_MS / 1000,
				}),
				signal,
			});
			if (!response.ok) {
				throw new Error(`Snowflake SQL API returned ${response.status}`);
			}
			const names = accessibleModelNames(await response.json());
			const models = catalog.filter((model) => names.has(model.id));
			if (models.length === 0) {
				throw new Error("No accessible Snowflake Cortex catalog models");
			}
			return models;
		},
		fallbackModels: catalog,
		logger,
	});

	const fetcher: ClearableModelFetcher = async (credentials) => {
		if (credentials.type !== "apikey") {
			logger.debug("[Snowflake] Wrong credential type, returning empty");
			return [];
		}
		if (!credentials.baseUrl) {
			logger.debug("[Snowflake] Missing baseUrl (no SNOWFLAKE_ACCOUNT), returning empty");
			return [];
		}
		return cached(credentials);
	};
	fetcher.clearCache = cached.clearCache;
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
