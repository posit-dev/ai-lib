/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { LoadCatalogOptions } from "ai-config/node";

import type { CancellationToken, Logger } from "../types.js";

export interface HeadlessProvidersOptions {
	readonly logger: Logger;
	readonly userAgent: string;
	/** For tests; production reads the default providers.json and process environment. */
	readonly catalog?: Pick<LoadCatalogOptions, "configPath" | "envVars">;
}

/** A catalog entry as plain data. Connection values stay inside the entry. */
export interface HeadlessProviderData {
	readonly id: string;
	readonly enabled: boolean;
	readonly custom?: true;
	/** `connection.baseUrl`, returned by the host's `positron.ai.getProviderBaseUrl`. */
	readonly baseUrl?: string;
	/** `connection.positaiLogin.scope`, read by the host's one-time credential copy. */
	readonly positaiLoginScope?: string;
	/** Dotted names of connection fields that differ from built-in defaults. */
	readonly customizedConnection?: readonly string[];
}

export interface HeadlessCatalogChange {
	readonly catalog: readonly HeadlessProviderData[];
	readonly enabledChanged: boolean;
	readonly connectionChanged: boolean;
	readonly modelsChanged: boolean;
}

export interface HeadlessProviderMapping {
	readonly providerId: string;
	/** The auth provider to read the session from; absent for local providers. */
	readonly authProviderId?: string;
	readonly scopes: readonly string[];
	/** False when credentials can come from the catalog alone: local endpoints, Foundry in Entra mode, and key-optional providers (litellm, openai-compatible, custom entries of key-optional kinds) with a base URL. A session, when there is one, still wins. */
	readonly requiresSession: boolean;
}

export interface HeadlessModel {
	readonly id: string;
	readonly name: string;
	readonly vendor: string;
	readonly providerId: string;
}

/** `credentialed` is false when the provider is unknown or no credential could be built, so the host can tell that apart from usable credentials with no models. */
export interface HeadlessModelListing {
	readonly credentialed: boolean;
	readonly models: readonly HeadlessModel[];
}

export interface HeadlessChatMessage {
	readonly role: "user" | "assistant";
	readonly content: string;
}

export interface HeadlessChatRequest {
	readonly providerId: string;
	readonly modelId: string;
	readonly sessionToken?: string;
	readonly systemPrompt: string;
	readonly messages: readonly HeadlessChatMessage[];
	readonly maxOutputTokens?: number;
}

export interface HeadlessProviders {
	readonly configPath: string;
	getCatalog(): Promise<readonly HeadlessProviderData[]>;
	onDidChangeCatalog(listener: (change: HeadlessCatalogChange) => void): { dispose(): void };
	getProviderMappings(): Promise<HeadlessProviderMapping[]>;
	/** `credentialed: false` with no models when the provider is unknown or has no credentials. */
	listModels(providerId: string, sessionToken: string | undefined): Promise<HeadlessModelListing>;
	/** Text deltas; throws when the provider has no credentials or client. */
	streamChat(request: HeadlessChatRequest, token: CancellationToken): AsyncIterable<string>;
	/** Idempotent. Stops the catalog watcher and drops listeners; later calls reject, and `onDidChangeCatalog` returns a no-op subscription. */
	dispose(): void;
}
