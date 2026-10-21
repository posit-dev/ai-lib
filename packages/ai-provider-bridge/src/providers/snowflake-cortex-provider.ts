/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ResolvedProviderId } from "ai-config";
import {
	getSnowflakeCortexModelCapabilities,
	isRecognizedSnowflakeCortexModel,
	SNOWFLAKE_CORTEX_CATALOG,
	snowflakeCortexModelName,
} from "ai-config";

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

/** A Cortex model, described entirely by `ai-config` from its id. */
function snowflakeModel(providerId: ResolvedProviderId, id: string): ModelInfo {
	return {
		id,
		name: snowflakeCortexModelName(id),
		providerId,
		vendor: "snowflake-cortex",
		...getSnowflakeCortexModelCapabilities(id),
	};
}

/** Lists the models the user's default role can use, with their lifecycle stage. */
const SHOW_MODELS_STATEMENT = "SHOW CORTEX BASE MODELS IN SCHEMA SNOWFLAKE.MODELS";

/** Lifecycle stages never offered: retired, deprecated, or Snowflake-internal. */
const UNLISTED_LIFECYCLE_STATUSES: ReadonlySet<unknown> = new Set(["EOL", "LEGACY", "INTERNAL"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Lowercased ids of the listable models in a SQL API v2 result for
 * {@link SHOW_MODELS_STATEMENT}, in row order: recognized by `ai-config` and
 * not in an unlisted lifecycle stage. Throws on any other shape, including a
 * 202 async-execution response (which carries no result set).
 */
function listedModelIds(body: unknown): string[] {
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
	const ids: string[] = [];
	for (const row of rows) {
		const name: unknown = Array.isArray(row) ? row[nameIndex] : undefined;
		if (typeof name !== "string") {
			throw new Error("Snowflake SQL API result has a malformed row");
		}
		const id = name.toLowerCase();
		if (
			UNLISTED_LIFECYCLE_STATUSES.has(row[statusIndex]) ||
			!isRecognizedSnowflakeCortexModel(id)
		) {
			continue;
		}
		ids.push(id);
	}
	return ids;
}

/**
 * Model discovery: the recognized models the account's default role can access
 * (via `SHOW CORTEX BASE MODELS` through the SQL API), in the order the API
 * returns them. Any failure — or a result with nothing listable — falls back to
 * the stale cache, then the static fallback list.
 */
function createSnowflakeModelFetcher(
	providerId: ResolvedProviderId,
	logger: Logger,
): ClearableModelFetcher {
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
			const ids = listedModelIds(await response.json());
			if (ids.length === 0) {
				throw new Error("No listable Snowflake Cortex models");
			}
			return ids.map((id) => snowflakeModel(providerId, id));
		},
		fallbackModels: SNOWFLAKE_CORTEX_CATALOG.map((id) => snowflakeModel(providerId, id)),
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
