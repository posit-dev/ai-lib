/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared contract for the provider-registration orchestrator (register-all-providers.ts):
 * the config interface, the orchestrator signature type, and the allow-list predicate.
 */

import type { BedrockProviderCallbacks } from "./providers/bedrock-provider";
import type { GoogleVertexProviderCallbacks } from "./providers/google-vertex-provider";
import type { ProviderRegistry } from "./providers/ProviderRegistry";
import type { Logger, ProviderId } from "./types";

export interface ProviderRegistrationConfig {
	/**
	 * Posit AI base URL. Accepts a getter so callers can resolve it lazily at fetch time --
	 * Positron reads the `authentication.positai.baseUrl` setting this way, so changes take
	 * effect without a reload. Flows straight through to `registerPositAiProvider`, which
	 * accepts both forms.
	 */
	positAiBaseUrl: string | (() => string);
	userAgent?: string;
	/** If set, only these providers register; otherwise all of them. */
	allowedProviders?: ProviderId[];
	/** Pre-built by the caller. The bridge must NOT construct these. */
	bedrockCallbacks?: BedrockProviderCallbacks;
	googleVertexCallbacks?: GoogleVertexProviderCallbacks;
}

/**
 * Signature for the registration orchestrator. `registerAllProviders` is annotated with this.
 */
export type RegisterAllProviders = (
	registry: ProviderRegistry,
	logger: Logger,
	config: ProviderRegistrationConfig,
) => void;

/**
 * Whether `id` should register, given an optional allow-list.
 *
 * - omitted/undefined: every provider is allowed.
 * - empty array: nothing is allowed.
 * - otherwise: only ids present in the array are allowed.
 */
export function isProviderAllowed(id: ProviderId, allowedProviders?: ProviderId[]): boolean {
	return !allowedProviders || allowedProviders.includes(id);
}
