/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ModelMessage } from "ai";
import type { ResolvedProvider } from "ai-config";
import {
	loadResolvedProviderCatalog,
	PROVIDERS_CONFIG_PATH,
	watchResolvedProviderCatalog,
} from "ai-config/node";
import type { LoadCatalogOptions } from "ai-config/node";

import { POSIT_AI_DEFAULTS } from "../provider-defaults.js";
import { ProviderRegistry } from "../providers/ProviderRegistry.js";
import { registerAllProviders } from "../register-all-providers.js";
import type { CancellationToken } from "../types.js";
import { toHeadlessProviderData } from "./catalog-data.js";
import { headlessCredentials } from "./credentials.js";
import { servableProviders } from "./mappings.js";
import { applyModelPolicy } from "./model-policy.js";
import type {
	HeadlessCatalogChange,
	HeadlessChatRequest,
	HeadlessModelListing,
	HeadlessProviders,
	HeadlessProvidersOptions,
} from "./types.js";

const UNCREDENTIALED: HeadlessModelListing = { credentialed: false, models: [] };

export function createHeadlessProviders(options: HeadlessProvidersOptions): HeadlessProviders {
	const { logger } = options;
	const configPath = options.catalog?.configPath ?? PROVIDERS_CONFIG_PATH;
	const listeners = new Set<(change: HeadlessCatalogChange) => void>();
	let catalog: readonly ResolvedProvider[] | undefined;
	let catalogReady: Promise<readonly ResolvedProvider[]> | undefined;
	let registry: Promise<ProviderRegistry> | undefined;
	let watcher: ReturnType<typeof watchResolvedProviderCatalog> | undefined;
	let disposed = false;

	function assertNotDisposed(): void {
		if (disposed) {
			throw new Error("Headless providers are disposed");
		}
	}

	const loadOptions: LoadCatalogOptions = {
		configPath,
		envVars: options.catalog?.envVars,
		// Positron is the only caller and always reads Workbench's enforced settings this way.
		legacyPositronEnforcedSettings: true,
		logger: {
			debug: (message) => logger.debug(`[AI Provider Catalog] ${message}`),
			warn: (message) => logger.warn(`[AI Provider Catalog] ${message}`),
		},
	};

	async function startCatalog(): Promise<readonly ResolvedProvider[]> {
		watcher = watchResolvedProviderCatalog((change) => {
			if (disposed) {
				return;
			}
			catalog = change.catalog;
			registry = undefined;
			const forwarded: HeadlessCatalogChange = {
				catalog: change.catalog.map(toHeadlessProviderData),
				enabledChanged: change.enabledChanged,
				connectionChanged: change.connectionChanged,
				modelsChanged: change.modelsChanged,
			};
			for (const listener of [...listeners]) {
				listener(forwarded);
			}
		}, loadOptions);
		await watcher.ready;
		assertNotDisposed();
		const loaded = await loadResolvedProviderCatalog(loadOptions);
		catalog ??= loaded;
		return catalog;
	}

	function currentCatalog(): Promise<readonly ResolvedProvider[]> {
		assertNotDisposed();
		catalogReady ??= startCatalog().catch((error: unknown) => {
			catalogReady = undefined;
			watcher?.dispose();
			throw error;
		});
		return catalogReady.then(() => {
			assertNotDisposed();
			return catalog ?? [];
		});
	}

	async function buildRegistry(): Promise<ProviderRegistry> {
		const providers = await currentCatalog();
		const clientKinds = new Map(
			servableProviders(providers).flatMap(({ mapping, clientKind }) =>
				clientKind ? [[mapping.providerId, clientKind] as const] : [],
			),
		);
		const built = new ProviderRegistry(logger);
		registerAllProviders(built, logger, {
			positAiBaseUrl:
				providers.find(({ id }) => id === "positai")?.connection.baseUrl ||
				POSIT_AI_DEFAULTS.baseUrl,
			userAgent: options.userAgent,
			customProviders: providers.flatMap(({ id }) => {
				const clientKind = clientKinds.get(id);
				return clientKind ? [{ id, clientKind }] : [];
			}),
		});
		return built;
	}

	function currentRegistry(): Promise<ProviderRegistry> {
		const building = (registry ??= buildRegistry());
		building.catch(() => {
			if (registry === building) {
				registry = undefined;
			}
		});
		return building;
	}

	async function credentialsFor(providerId: string, sessionToken: string | undefined) {
		const providers = await currentCatalog();
		const servable = servableProviders(providers).find((s) => s.mapping.providerId === providerId);
		if (!servable) {
			return undefined;
		}
		const connectionFor = (id: string) => providers.find((p) => p.id === id)?.connection;
		const credentials = headlessCredentials(servable, connectionFor, sessionToken, logger);
		return credentials && { servable, credentials, providers };
	}

	/** Discovery is cached per registry, and the registry is rebuilt on catalog change. */
	async function resolveListing(providerId: string, sessionToken: string | undefined) {
		const resolved = await credentialsFor(providerId, sessionToken);
		if (!resolved) {
			return undefined;
		}
		const provider = resolved.providers.find((p) => p.id === providerId);
		const registry = await currentRegistry();
		const discovered =
			provider?.models?.discovery === "off"
				? []
				: await registry.getModelsForProvider(providerId, resolved.credentials);
		return { ...resolved, registry, ...applyModelPolicy(provider, providerId, discovered) };
	}

	async function listModels(
		providerId: string,
		sessionToken: string | undefined,
	): Promise<HeadlessModelListing> {
		const listing = await resolveListing(providerId, sessionToken);
		return listing ? { credentialed: true, models: listing.models } : UNCREDENTIALED;
	}

	async function* streamChat(
		request: HeadlessChatRequest,
		token: CancellationToken,
	): AsyncGenerator<string> {
		const resolved = await resolveListing(request.providerId, request.sessionToken);
		if (!resolved) {
			throw new Error(`No credentials for provider ${request.providerId}`);
		}
		if (!resolved.models.some((model) => model.id === request.modelId)) {
			throw new Error(
				`Model "${request.modelId}" is no longer available from "${request.providerId}".`,
			);
		}
		const route = resolved.routes.get(request.modelId);
		const client = resolved.registry.getClientForProviderOrKind(
			request.providerId,
			resolved.credentials,
			resolved.servable.clientKind,
		);
		if (!client) {
			throw new Error(`No client for provider ${request.providerId}`);
		}
		const messages: ModelMessage[] = request.messages.map((message) => ({
			role: message.role,
			content: message.content,
		}));
		const stream = await client.chat({
			model: request.modelId,
			messages,
			systemPrompt: request.systemPrompt,
			maxOutputTokens: request.maxOutputTokens,
			cancellationToken: token,
			protocol: route?.protocol,
			baseUrl: route?.baseUrl,
		});
		for await (const part of stream) {
			if (token.isCancellationRequested) {
				break;
			}
			if (part.type === "error") {
				throw part.error instanceof Error
					? part.error
					: new Error(`Provider ${request.providerId} request failed: ${String(part.error)}`);
			}
			if (part.type === "text-delta") {
				yield part.text;
			}
		}
	}

	return {
		configPath,
		async getCatalog() {
			return (await currentCatalog()).map(toHeadlessProviderData);
		},
		onDidChangeCatalog(listener) {
			if (disposed) {
				return { dispose() {} };
			}
			listeners.add(listener);
			return { dispose: () => void listeners.delete(listener) };
		},
		async getProviderMappings() {
			return servableProviders(await currentCatalog()).map((servable) => servable.mapping);
		},
		listModels,
		streamChat,
		dispose() {
			if (disposed) {
				return;
			}
			disposed = true;
			listeners.clear();
			watcher?.dispose();
			watcher = undefined;
			catalog = undefined;
			catalogReady = undefined;
			registry = undefined;
		},
	};
}
