/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider Plugin Registry - Backend Plugin System
 *
 * This registry allows providers to register their backend implementations
 * (model fetchers and client factories) without modifying core services.
 *
 * Adding a new provider requires:
 * 1. Registering a model fetcher (async function that returns ModelInfo[])
 * 2. Registering a client factory (function that creates a ModelClient)
 */

import type { ClientKind } from "ai-config";

import type { ModelClient } from "../model-clients/ModelClient";
import type { Logger, ModelInfo, ProviderId, ProviderCredentials } from "../types";
import type {
	ModelRequestCoalescer,
	ModelRequestExecutor,
	ModelRequestIdentity,
} from "./request-coalescer";
import { InFlightRequestCoalescer } from "./request-coalescer";

const USER_AGENT_HEADER_NAME = "user-agent";

// ---------------------------------------------------------------------------
// Client-kind → factory-id mapping
// ---------------------------------------------------------------------------

/**
 * Non-identity client-kind → factory-id mapping table.
 *
 * **Single source of truth.** The resolver (`resolveFactoryId`) and the
 * shape guard (`NON_IDENTITY_CLIENT_KINDS`, `NON_IDENTITY_FACTORY_IDS`)
 * are all derived from this one constant. Add new non-identity entries
 * here and everything else updates automatically.
 *
 * Client kinds not listed here resolve to a factory registered under the
 * same name (identity). These non-identity entries exist because some
 * built-in providers register their factory under the provider id
 * (e.g. "bedrock"), but the corresponding client kind uses a different
 * label (e.g. "aws").
 */
export const NON_IDENTITY_MAPPING = [
	["aws", "bedrock"],
	["snowflake", "snowflake-cortex"],
] as const satisfies ReadonlyArray<readonly [ClientKind, ProviderId]>;

/**
 * Non-identity client-kind keys — derived from `NON_IDENTITY_MAPPING` at
 * the type level. The shape guard uses this to verify every ai-config
 * `ClientKind` resolves to a registered factory.
 */
export type NonIdentityClientKind = (typeof NON_IDENTITY_MAPPING)[number][0];

/**
 * Non-identity factory ids — derived from `NON_IDENTITY_MAPPING` at the
 * type level. The shape guard uses this to verify the targets are valid
 * provider ids.
 */
export type NonIdentityFactoryId = (typeof NON_IDENTITY_MAPPING)[number][1];

/** Lookup map built from the canonical table. */
const CLIENT_KIND_TO_FACTORY_ID = new Map<string, string>(NON_IDENTITY_MAPPING);

/** Resolve the factory registration key for a given client kind. */
function resolveFactoryId(clientKind: ClientKind): string {
	return CLIENT_KIND_TO_FACTORY_ID.get(clientKind) ?? clientKind;
}

/**
 * Function that fetches models for a provider
 * Called when auth status changes or models need refreshing
 *
 * @param credentials - Provider credentials (API key, token, endpoint, etc.)
 * @param metadata - Optional provider-specific metadata from auth status
 * @returns Array of available models for this provider
 */
export type ModelFetcher = (
	credentials: ProviderCredentials,
	metadata?: Record<string, unknown>,
) => Promise<ModelInfo[]>;

type ClearableModelFetcher = ModelFetcher & {
	clearCache?: () => void;
	getFetchState?: () => unknown;
};

/**
 * Function that creates an API client for a provider
 * Called when making chat requests to this provider
 *
 * @param credentials - Provider credentials
 * @returns ModelClient instance for making API calls
 */
export type ClientFactory = (credentials: ProviderCredentials) => ModelClient;

/**
 * Registry for provider implementations
 *
 * Providers register their backend implementations here:
 * - Model fetcher: Returns list of available models
 * - Client factory: Creates API client for chat requests
 *
 * The registry is used by ModelService to discover models and send requests
 * without hard-coded provider logic.
 */
export class ProviderRegistry implements ModelRequestCoalescer {
	private modelFetchers = new Map<string, ClearableModelFetcher>();
	private clientFactories = new Map<string, ClientFactory>();
	private defaultUserAgent: string | undefined;
	/**
	 * In-flight-only request coalescer, owned per registry so a replaced
	 * registry can never join an old registry's flight. Opted-in fetchers
	 * reach it through {@link coalesceModelRequest}.
	 */
	private readonly requestCoalescer = new InFlightRequestCoalescer();

	constructor(private readonly logger: Logger) {}

	/**
	 * Set the product identity added to provider credentials that support custom
	 * headers. An explicit non-empty User-Agent always wins. Hosts may update the
	 * value after registration; the latest value applies when credentials next
	 * enter a fetcher or client factory.
	 */
	setDefaultUserAgent(userAgent: string | undefined): void {
		this.defaultUserAgent = userAgent;
	}

	private withDefaultUserAgent(credentials: ProviderCredentials): ProviderCredentials {
		if (
			!this.defaultUserAgent ||
			(credentials.type !== "apikey" && credentials.type !== "azure-entra")
		) {
			return credentials;
		}

		const customHeaderEntries = Object.entries(credentials.customHeaders ?? {});
		if (
			customHeaderEntries.some(
				([name, value]) => name.toLowerCase() === USER_AGENT_HEADER_NAME && value.length > 0,
			)
		) {
			return credentials;
		}

		const customHeaders = Object.fromEntries(
			customHeaderEntries.filter(([name]) => name.toLowerCase() !== USER_AGENT_HEADER_NAME),
		);
		return {
			...credentials,
			customHeaders: { ...customHeaders, "User-Agent": this.defaultUserAgent },
		};
	}

	/**
	 * Join an identical in-flight model-discovery request instead of issuing a
	 * second HTTP request. Opted-in fetchers call this with their provider id
	 * and the normalized request identity; see request-coalescer.ts for the
	 * clear/join and cancellation contract. In-flight only — completed results
	 * are owned by each fetcher's own TTL cache.
	 */
	coalesceModelRequest(
		providerId: string,
		identity: ModelRequestIdentity,
		caller: AbortSignal,
		execute: ModelRequestExecutor,
	): Promise<unknown> {
		return this.requestCoalescer.coalesceModelRequest(providerId, identity, caller, execute);
	}

	/**
	 * Register a model fetcher for a provider
	 *
	 * @param providerId - Provider ID (e.g., "anthropic", "openrouter")
	 * @param fetcher - Async function that returns models
	 */
	registerModelFetcher(providerId: string, fetcher: ModelFetcher): void {
		// A replaced fetcher must not join a flight its predecessor started:
		// retire the provider's outstanding shared requests first.
		this.requestCoalescer.retireProvider(providerId);
		this.modelFetchers.set(providerId, fetcher as ClearableModelFetcher);
	}

	/**
	 * Register a client factory for a provider
	 *
	 * @param providerId - Provider ID
	 * @param factory - Function that creates ModelClient
	 */
	registerClientFactory(providerId: string, factory: ClientFactory): void {
		this.clientFactories.set(providerId, factory);
	}

	/**
	 * Get models for a provider
	 * Returns empty array if provider not registered or fetch fails
	 *
	 * @param providerId - Provider ID
	 * @param credentials - Provider credentials
	 * @param metadata - Optional provider metadata
	 * @returns Array of models or empty array
	 */
	async getModelsForProvider(
		providerId: string,
		credentials: ProviderCredentials,
		metadata?: Record<string, unknown>,
	): Promise<ModelInfo[]> {
		const fetcher = this.modelFetchers.get(providerId);

		if (!fetcher) {
			this.logger.warn(`No model fetcher registered for ${providerId}`);
			return [];
		}

		try {
			return await fetcher(this.withDefaultUserAgent(credentials), metadata);
		} catch (error) {
			this.logger.error(`Error fetching models for ${providerId}:`, error);
			return [];
		}
	}

	/**
	 * Clear all provider-level model caches.
	 * Called when credentials change (sign-out, key removal) to ensure
	 * the next model fetch hits the API instead of returning stale data.
	 */
	clearAllModelCaches(): void {
		// Retire all in-flight shared requests: a post-clear call must not
		// join a pre-clear flight. Attached callers still finish.
		this.requestCoalescer.retireAll();
		for (const [providerId, fetcher] of this.modelFetchers) {
			if (fetcher.clearCache) {
				this.logger.debug(`[ProviderRegistry] Clearing model cache for ${providerId}`);
				fetcher.clearCache();
			}
		}
	}

	clearModelCache(providerId: string): void {
		// Retire exactly the in-flight shared requests this provider
		// participates in; other providers' callers on a shared flight are
		// not cancelled.
		this.requestCoalescer.retireProvider(providerId);
		const fetcher = this.modelFetchers.get(providerId);
		if (fetcher?.clearCache) {
			this.logger.debug(`[ProviderRegistry] Clearing model cache for ${providerId}`);
			fetcher.clearCache();
		}
	}

	getModelFetchState<T>(providerId: string): T | undefined {
		const fetcher = this.modelFetchers.get(providerId);
		if (!fetcher?.getFetchState) {
			return undefined;
		}
		return fetcher.getFetchState() as T | undefined;
	}

	/**
	 * Get client for a provider
	 * Returns null if provider not registered
	 *
	 * @param providerId - Provider ID
	 * @param credentials - Provider credentials
	 * @returns ModelClient or null
	 */
	getClientForProvider(providerId: string, credentials: ProviderCredentials): ModelClient | null {
		const factory = this.clientFactories.get(providerId);

		if (!factory) {
			this.logger.warn(`No client factory registered for ${providerId}`);
			return null;
		}

		return factory(this.withDefaultUserAgent(credentials));
	}

	/**
	 * Get client for a provider, falling back to a client-kind lookup for
	 * custom providers that have no direct factory registration.
	 *
	 * For built-in providers, this behaves identically to `getClientForProvider`.
	 * For custom providers whose `providerId` is not in the factory map, it
	 * resolves the `clientKind` to the corresponding built-in factory via
	 * `CLIENT_KIND_TO_FACTORY_ID` (non-identity mappings) or identity.
	 *
	 * @param providerId - Provider ID (built-in or custom)
	 * @param credentials - Provider credentials
	 * @param clientKind - Client kind for fallback resolution (from catalog)
	 * @returns ModelClient or null
	 */
	getClientForProviderOrKind(
		providerId: string,
		credentials: ProviderCredentials,
		clientKind?: ClientKind,
	): ModelClient | null {
		const credentialsWithUserAgent = this.withDefaultUserAgent(credentials);

		// Try direct registration first (built-ins and any manually registered)
		const directFactory = this.clientFactories.get(providerId);
		if (directFactory) return directFactory(credentialsWithUserAgent);

		// Fall back to clientKind → factory id mapping
		if (clientKind) {
			const factoryId = resolveFactoryId(clientKind);
			const kindFactory = this.clientFactories.get(factoryId);
			if (kindFactory) return kindFactory(credentialsWithUserAgent);
		}

		this.logger.warn(`No client factory for ${providerId} (clientKind: ${clientKind})`);
		return null;
	}
}
